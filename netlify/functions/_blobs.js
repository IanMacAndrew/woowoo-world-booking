const { getStore: getStoreRaw, connectLambda } = require('@netlify/blobs');

// WHY THIS FILE EXISTS
// Every function on this site is written in Netlify's older "Lambda" style
// (exports.handler = async (event) => ...). In that style Netlify only
// provides Blobs credentials if the function first calls connectLambda(event)
// with the incoming event. Until now nothing did, so storage had no built-in
// credentials and we were forced onto a hand-made personal access token
// (NETLIFY_BLOBS_TOKEN) -- which expires, and every expiry shows up as
// "Netlify Blobs has generated an internal error (401 status code)".
//
// HOW IT WORKS NOW
//  1. Each handler calls connect(event) first. That uses Netlify's own
//     per-invocation credentials, which never expire or need regenerating.
//  2. If, for any reason, those credentials are rejected (401/403) or absent,
//     the explicit NETLIFY_SITE_ID + NETLIFY_BLOBS_TOKEN pair is tried instead,
//     and vice versa -- so whichever credential is currently valid wins and a
//     stale token no longer takes the site down.
//  3. Only authentication failures trigger the retry; any other error is
//     raised immediately, exactly as before.

let contextConnected = false;

// Call once at the top of every handler, passing the incoming event. Safe to
// call with anything (scheduled runs, local tests): it never throws.
function connect(event) {
  contextConnected = false;
  try {
    if (event && event.blobs && event.headers) {
      connectLambda(event);
      contextConnected = true;
    }
  } catch (err) {
    console.warn('connectLambda failed; will rely on the explicit token if one is set:', err && err.message);
  }
}

function explicitStore(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  return siteID && token ? getStoreRaw({ name, siteID, token }) : null;
}

function isAuthError(err) {
  const msg = String((err && err.message) || '');
  return /\b(401|403)\b/.test(msg) || /unauthori[sz]ed|forbidden/i.test(msg);
}

const METHODS = ['get', 'getWithMetadata', 'getMetadata', 'set', 'setJSON', 'delete', 'list'];

function getStore(name) {
  // Preference order depends on whether this invocation has built-in credentials.
  const factories = contextConnected
    ? [() => getStoreRaw(name), () => explicitStore(name)]
    : [() => explicitStore(name), () => getStoreRaw(name)];

  const store = {};
  for (const method of METHODS) {
    store[method] = async (...args) => {
      let lastErr;
      for (const make of factories) {
        let candidate;
        try {
          candidate = make(); // may throw if this credential type isn't configured
        } catch (err) {
          lastErr = err;
          continue;
        }
        if (!candidate) continue; // e.g. no explicit token set
        try {
          return await candidate[method](...args);
        } catch (err) {
          lastErr = err;
          if (!isAuthError(err)) throw err; // real error: don't mask it
          // auth rejected: fall through and try the other credential
        }
      }
      throw lastErr || new Error('Netlify Blobs is not configured for this function');
    };
  }
  return store;
}

module.exports = { getStore, connect };
