// src/msalConfig.js — MSAL config for "Sign in with Microsoft" staff login.
// Reuses the same Azure app registration as OneDrive/Graph (see server/auth.js)
// with a Single-page application platform + redirect URI added in Azure Portal.
// Restricted to the company's own tenant (authority below), which is what
// actually stops accounts outside the organization from signing in — this
// is enforced again server-side in server/staffAuth.js, not just here.
export const msalConfig = {
  auth: {
    clientId: import.meta.env.VITE_AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${import.meta.env.VITE_AZURE_TENANT_ID}`,
    redirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
};

export const loginRequest = {
  scopes: ['openid', 'profile', 'email'],
};
