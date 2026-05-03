require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const axios = require('axios');

let cache = null; // { accessToken, expiresAt }

async function getValidToken() {
  if (cache && cache.expiresAt > Date.now()) return cache.accessToken;

  const url = `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'https://graph.microsoft.com/.default',
  });

  const res = await axios.post(url, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  cache = {
    accessToken: res.data.access_token,
    expiresAt: Date.now() + (res.data.expires_in - 60) * 1000,
  };

  return cache.accessToken;
}

module.exports = { getValidToken };
