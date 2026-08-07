const { getStore: getStoreRaw } = require('@netlify/blobs');

// Netlify is supposed to auto-inject Blobs credentials into every function
// invocation, but this has been unreliable in practice (see
// https://answers.netlify.com/t/missingblobsenvironmenterror-on-fresh-sites/164777
// and several other open reports of the same thing on otherwise-correctly-
// configured sites). Passing siteID/token explicitly is the documented,
// reliable workaround — see https://docs.netlify.com/build/data-and-storage/netlify-blobs/
//
// Requires two environment variables set in Netlify (Project configuration
// > Environment variables):
//   NETLIFY_SITE_ID    — this site's Project ID (Project configuration > General)
//   NETLIFY_BLOBS_TOKEN — a Personal Access Token (User settings > Applications)
function getStore(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) {
    return getStoreRaw({ name, siteID, token });
  }
  // Fall back to automatic config in case it starts working / for netlify dev.
  return getStoreRaw(name);
}

module.exports = { getStore };
