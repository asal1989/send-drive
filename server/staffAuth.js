// server/staffAuth.js — verifies Microsoft-signed ID tokens for the staff-only
// login gate. Reuses the SAME Azure app registration already used for
// OneDrive/Graph (AZURE_CLIENT_ID / AZURE_TENANT_ID) — just a different auth
// flow (interactive user sign-in) rather than the app-only client-credentials
// flow auth.js does. Requires the app registration to have a Single-page
// application platform with a redirect URI added in Azure Portal.
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const TENANT_ID = () => process.env.AZURE_TENANT_ID;
const CLIENT_ID = () => process.env.AZURE_CLIENT_ID;
// Optional extra check: restrict to a specific email domain even if the
// tenant ever has guest accounts from other organizations. Leave unset to
// skip this check (tenant restriction below is the real enforcement).
const STAFF_DOMAIN = () => (process.env.STAFF_EMAIL_DOMAIN || '').toLowerCase();

const client = jwksClient({
  jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
  cache: true,
  cacheMaxAge: 24 * 60 * 60 * 1000,
});

function getSigningKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

/**
 * Verifies a Microsoft Entra ID (Azure AD) ID token.
 * Checks: valid signature (Microsoft's public keys), correct audience
 * (our app), correct issuer (our specific tenant only — this is what
 * actually enforces "company accounts only", not the domain check).
 * Returns { email, name } on success, throws on any failure.
 */
function verifyIdToken(idToken) {
  return new Promise((resolve, reject) => {
    if (!TENANT_ID() || !CLIENT_ID()) {
      return reject(new Error('AZURE_TENANT_ID / AZURE_CLIENT_ID not configured'));
    }
    jwt.verify(idToken, getSigningKey, {
      algorithms: ['RS256'],
      audience: CLIENT_ID(),
      issuer: `https://login.microsoftonline.com/${TENANT_ID()}/v2.0`,
    }, (err, decoded) => {
      if (err) return reject(err);
      const email = String(decoded.preferred_username || decoded.email || '').toLowerCase();
      if (!email) return reject(new Error('Token has no email/preferred_username claim'));
      if (STAFF_DOMAIN() && !email.endsWith(`@${STAFF_DOMAIN()}`)) {
        return reject(new Error(`Email domain not allowed: ${email}`));
      }
      resolve({ email, name: decoded.name || email });
    });
  });
}

module.exports = { verifyIdToken };
