const { google } = require('googleapis');

/**
 * Google Indexing API Utility
 * This function notifies Google Search whenever a new URL is published or updated.
 * 
 * @param {string} url The clean URL of the new article/page
 * @param {string} type Notification type: 'URL_UPDATED' or 'URL_DELETED'
 */
async function notifyGoogleIndexing(url, type = 'URL_UPDATED') {
  try {
    // 1. Get credentials from environment variables
    const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!clientEmail || !privateKey) {
      console.warn('⚠️ Google Indexing API credentials missing. Skipping notification.');
      return;
    }

    // 2. Initialize JWT auth
    const jwtClient = new google.auth.JWT(
      clientEmail,
      null,
      privateKey,
      ['https://www.googleapis.com/auth/indexing'],
      null
    );

    await jwtClient.authorize();

    // 3. Send request to Indexing API
    const options = {
      url: 'https://indexing.googleapis.com/v3/urlNotifications:publish',
      method: 'POST',
      auth: jwtClient,
      data: {
        url: url,
        type: type,
      },
    };

    const result = await google.indexing('v3').urlNotifications.publish(options);
    console.log(`✅ Google Indexing success for: ${url}`, result.data);
    return result.data;

  } catch (error) {
    console.error(`❌ Google Indexing failed for: ${url}`, error.response?.data || error.message);
  }
}

module.exports = { notifyGoogleIndexing };
