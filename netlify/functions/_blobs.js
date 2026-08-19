const { getStore: getStoreRaw } = require('@netlify/blobs');

// Netlify is *supposed* to auto-inject Blobs credentials into every function
// invocation. This project previously worked around that with an explicit
// siteID/token (see git history), because of a documented reliability issue
// with automatic config — but that manual path is now the one producing
// unexplained 401s (Netlify Blobs rejecting a freshly-regenerated, correctly
// -scoped, "All scopes" Personal Access Token), even though nothing else
// about it looks wrong. Flipping the priority: try automatic config FIRST,
// fall back to the manual siteID/token only if that fails. This is a live
// diagnostic as much as a fix — if automatic config also 401s, the problem
// isn't the token at all; if it works, the manual path itself was the bug.
function getStore(name) {
  try {
    return getStoreRaw(name);
  } catch (err) {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN;
    if (siteID && token) {
      console.warn('Automatic Blobs config failed, falling back to explicit siteID/token:', err.message);
      return getStoreRaw({ name, siteID, token });
    }
    throw err;
  }
}

module.exports = { getStore };
