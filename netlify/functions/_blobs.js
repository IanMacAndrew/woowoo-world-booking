const { getStore: getStoreRaw } = require('@netlify/blobs');

// Netlify is *supposed* to auto-inject Blobs credentials into every function
// invocation. A previous version of this file tried automatic config first
// and only fell back to an explicit siteID/token if getStoreRaw() itself
// threw -- but that can't actually catch the failure mode we're hitting:
// getStoreRaw() succeeds synchronously either way (it just builds a client),
// and the 401 only shows up later, asynchronously, the first time something
// calls .list()/.get()/etc. on the store it returned. So that fallback
// logic was structurally unable to ever trigger for this error.
//
// Reverting to what's actually confirmed to have worked before (see git
// history): prefer the explicit siteID/token when both are present, and
// only fall back to automatic config if they're missing. If this still
// 401s, the explicit token itself has likely gone stale again and needs
// regenerating in the Netlify dashboard (Site configuration -> Environment
// variables -> NETLIFY_BLOBS_TOKEN) -- that's happened once before.
function getStore(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) {
    return getStoreRaw({ name, siteID, token });
  }
  return getStoreRaw(name);
}

module.exports = { getStore };
