// Netlify serverless function to proxy the beehiiv RSS feed
// This avoids CORS issues by fetching server-side
exports.handler = async (event) => {
  const RSS_URL = 'https://rss.beehiiv.com/feeds/3nmhneFY2D.xml';

  try {
    const response = await fetch(RSS_URL);
    if (!response.ok) {
      throw new Error(`RSS fetch failed: ${response.status}`);
    }
    const xml = await response.text();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/xml',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300', // Cache for 5 minutes
      },
      body: xml,
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message }),
    };
  }
};
