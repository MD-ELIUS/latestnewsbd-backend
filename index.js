const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');
require('dotenv').config();
const admin = require('firebase-admin');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { notifyGoogleIndexing } = require('./googleIndexing');

dayjs.extend(utc);
dayjs.extend(timezone);

const BD_TZ = 'Asia/Dhaka';

let serviceAccount;
try {
  // Try to load from local file (for local development)
  serviceAccount = require('./serviceAccountKey.json');
} catch (error) {
  // If local file is not found (which is true on Render since we gitignore it),
  // load from Environment Variable
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT environment variable is missing!");
    process.exit(1);
  }
}

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    console.log("Connected successfully to MongoDB");

    const database = client.db(process.env.DB_NAME || 'newsBD');
    const tokenCollection = database.collection(process.env.COLLECTION_NAME || 'fcm_token');
    const newsCollection = database.collection('news');

    // API to save or update token
    app.post('/api/save-token', async (req, res) => {
      const { token } = req.body;
      console.log("📢 Received token request:", token ? "Token present" : "Token MISSING");

      if (!token) {
        return res.status(400).send({ error: 'Token is required' });
      }

      try {
        const result = await tokenCollection.updateOne(
          { token: token },
          {
            $set: {
              token: token,
              updatedAt: new Date()
            },
            $setOnInsert: {
              createdAt: new Date()
            }
          },
          { upsert: true }
        );

        if (result.upsertedCount > 0) {
          console.log("✅ Token saved successfully (New):", token.substring(0, 20) + "...");
          res.status(201).send({ message: 'Token saved successfully', id: result.upsertedId });
        } else {
          console.log("✅ Token updated successfully (Existing):", token.substring(0, 20) + "...");
          res.status(200).send({ message: 'Token updated successfully' });
        }
      } catch (err) {
        console.error("Error saving token:", err);
        res.status(500).send({ error: 'Failed to save token' });
      }
    });

    // API to send notifications for news from the last 10 minutes
    app.get('/api/send-news-notifications', async (req, res) => {
      try {
        console.log("🚀 Starting notification process...");

        // 1. Calculate the time 10 minutes ago
        const tenMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);

        // 2. Fetch news from the last 10 minutes (Limit to 3 to avoid multiple notifications)
        const recentNews = await newsCollection.find({
          createdAt: { $gte: tenMinutesAgo.toISOString() }
        }).sort({ createdAt: -1 }).limit(3).toArray();

        // Fallback for Date objects if stored as Date
        if (recentNews.length === 0) {
          const recentNewsDate = await newsCollection.find({
            createdAt: { $gte: tenMinutesAgo }
          }).sort({ createdAt: -1 }).limit(3).toArray();
          if (recentNewsDate.length > 0) recentNews.push(...recentNewsDate);
        }

        if (recentNews.length === 0) {
          console.log("ℹ️ No new news in the last 10 minutes.");
          return res.status(200).send({ message: 'No new news to notify' });
        }

        console.log(`🗞️ Found ${recentNews.length} new news items.`);

        // 3. Fetch all active tokens
        const tokensData = await tokenCollection.find({}).toArray();
        const tokens = tokensData.map(t => t.token);

        if (tokens.length === 0) {
          console.log("⚠️ No registered tokens found.");
          return res.status(200).send({ message: 'No registered tokens' });
        }

        const results = [];

        // 4. Send notifications for each news item
        for (const news of recentNews) {
          const message = {
            data: {
              title: String(news.title),
              body: String(news.description).substring(0, 100) + (String(news.description).length > 100 ? '...' : ''),
              image: String(news.imageCloudinary || news.image),
              url: `https://latestnewsbd.vercel.app/news/${news.slug}`
            },
            tokens: tokens,
          };

          const response = await admin.messaging().sendEachForMulticast(message);

          // 5. Cleanup inactive tokens
          if (response.failureCount > 0) {
            const failedTokens = [];
            response.responses.forEach((resp, idx) => {
              if (!resp.success) {
                const errorCode = resp.error.code;
                if (errorCode === 'messaging/registration-token-not-registered' ||
                  errorCode === 'messaging/invalid-registration-token') {
                  failedTokens.push(tokens[idx]);
                }
              }
            });

            if (failedTokens.length > 0) {
              await tokenCollection.deleteMany({ token: { $in: failedTokens } });
              console.log(`🧹 Cleaned up ${failedTokens.length} inactive tokens.`);
            }
          }

          results.push({
            newsId: news._id,
            successCount: response.successCount,
            failureCount: response.failureCount
          });
        }

        res.status(200).send({
          message: 'Notifications processed',
          newsCount: recentNews.length,
          tokensCount: tokens.length,
          details: results
        });

      } catch (err) {
        console.error("❌ Error sending notifications:", err);
        res.status(500).send({ error: 'Failed to send notifications' });
      }
    });

    // === NEW ROUTES MIGRATED FROM NEXT.JS === //

    // 1. GET /api/news/most-read
    app.get('/api/news/most-read', async (req, res) => {
      const page = parseInt(req.query.page || '1', 10);
      const limit = parseInt(req.query.limit || '12', 10);
      const category = req.query.category || null;

      try {
        const query = {};
        if (category && String(category).trim()) {
          query.category = category;
        }

        const total = await newsCollection.countDocuments(query);
        const news = await newsCollection
          .find(query)
          .sort({ viewCount: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray();

        res.status(200).json({ news, total, page, limit });
      } catch (err) {
        console.error('[API/news/most-read]', err);
        res.status(500).json({ error: 'Failed to fetch most-read news' });
      }
    });

    // 2. GET /api/news/search
    app.get('/api/news/search', async (req, res) => {
      const query = req.query.q || '';
      const limit = parseInt(req.query.limit || '20', 10);

      if (!query) return res.status(200).json({ news: [] });

      try {
        const news = await newsCollection
          .find({
            $or: [
              { title: { $regex: query, $options: 'i' } },
              { description: { $regex: query, $options: 'i' } },
              { tags: { $regex: query, $options: 'i' } },
            ],
          })
          .sort({ sourceTime: -1, createdAt: -1 })
          .limit(limit)
          .toArray();

        res.status(200).json({ news });
      } catch (err) {
        console.error('[API/news/search]', err);
        res.status(500).json({ news: [], error: 'Search failed' });
      }
    });

    // 3. GET /api/news/trending
    app.get('/api/news/trending', async (req, res) => {
      const limit = parseInt(req.query.limit || '5', 10);

      try {
        const news = await newsCollection
          .find({})
          .sort({ viewCount: -1 })
          .limit(limit)
          .toArray();

        res.status(200).json({ news });
      } catch (err) {
        console.error('[API/news/trending]', err);
        res.status(500).json({ error: 'Failed to fetch trending news' });
      }
    });

    // 4. POST /api/news/indexing
    app.post('/api/news/indexing', async (req, res) => {
      try {
        const { url, key } = req.body;

        const INDEXING_KEY = process.env.INDEXING_KEY || 'your_secret_indexing_key';
        if (key !== INDEXING_KEY) {
          return res.status(401).json({ error: 'Unauthorized' });
        }

        if (!url) {
          return res.status(400).json({ error: 'URL is required' });
        }

        const result = await notifyGoogleIndexing(url);

        res.status(200).json({ 
          success: true, 
          message: 'Indexing notification sent to Google',
          data: result 
        });

      } catch (err) {
        console.error('[API/Indexing Error]', err);
        res.status(500).json({ error: 'Internal Server Error', details: err.message });
      }
    });

    // 5. GET /api/news
    app.get('/api/news', async (req, res) => {
      const page = parseInt(req.query.page || '1', 10);
      const limit = parseInt(req.query.limit || '10', 10);
      const date = req.query.date || null;
      const category = req.query.category || null;
      const subcategory = req.query.subcategory || req.query.sub || null;

      try {
        const query = {};
        if (date) {
          const bdStartOfDay = dayjs.tz(date, BD_TZ).startOf('day');
          const startStr = bdStartOfDay.toISOString();
          const endStr = bdStartOfDay.endOf('day').toISOString();

          query.$or = [
            { sourceTime: { $gte: startStr, $lte: endStr } },
            { 
              $and: [
                { $or: [{ sourceTime: { $exists: false } }, { sourceTime: null }] },
                { createdAt: { $gte: startStr, $lte: endStr } }
              ] 
            }
          ];
        }
        if (category) query.category = category;
        if (subcategory) query.subcategory = subcategory;

        const total = await newsCollection.countDocuments(query);
        const news = await newsCollection
          .find(query)
          .sort({ sourceTime: -1, createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray();

        res.status(200).json({ news, total, page, limit });
      } catch (err) {
        console.error('[API/news]', err);
        res.status(500).json({ error: 'Failed to fetch news', details: err.message });
      }
    });

    // 6. GET /api/news/:slug (Must be last)
    app.get('/api/news/:slug', async (req, res) => {
      const { slug } = req.params;

      try {
        const news = await newsCollection.findOne({ slug });
        if (!news) return res.status(404).json({ error: 'News not found' });

        // Increment view count asynchronously
        newsCollection.updateOne({ slug }, { $inc: { viewCount: 1 } }).catch(console.error);

        res.status(200).json({ news });
      } catch (err) {
        console.error('[API/news/slug]', err);
        res.status(500).json({ error: 'Failed to fetch news article' });
      }
    });

    // Root route
    app.get('/', (req, res) => {
      res.send('FCM Token Server is running');
    });

    app.listen(port, () => {
      console.log(`Server is running on http://localhost:${port}`);
    });

  } catch (err) {
    console.error("Connection error:", err);
  }
}

run().catch(console.dir);
