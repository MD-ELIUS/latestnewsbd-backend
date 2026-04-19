const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');
require('dotenv').config();
const admin = require('firebase-admin');

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
        const tenMinutesAgo = new Date(Date.now() - 20* 60 * 1000);
        
        // 2. Fetch news from the last 10 minutes
        const recentNews = await newsCollection.find({
          createdAt: { $gte: tenMinutesAgo.toISOString() }
        }).sort({ createdAt: -1 }).toArray();

        // Fallback for Date objects if stored as Date
        if (recentNews.length === 0) {
           const recentNewsDate = await newsCollection.find({
            createdAt: { $gte: tenMinutesAgo }
          }).sort({ createdAt: -1 }).toArray();
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
