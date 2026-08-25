const { getStore } = require('./_blobs');

function page(message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribed — WooWoo World</title>
  <style>body{font-family:sans-serif;background:#F4F2F8;color:#1C0333;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
  .box{background:#fff;padding:40px;border-radius:12px;max-width:420px;text-align:center;box-shadow:0 6px 20px rgba(28,3,51,0.15);}</style>
  </head><body><div class="box"><h2>WooWoo World</h2><p>${message}</p></div></body></html>`;
}

exports.handler = async (event) => {
  const email = ((event.queryStringParameters || {}).email || '').trim().toLowerCase();
  if (!email) {
    return { statusCode: 400, headers: { 'Content-Type': 'text/html' }, body: page('Missing email address.') };
  }

  try {
    const store = getStore('campaign-suppression');
    await store.setJSON(`suppressed:${email}`, { email, unsubscribedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Failed to record unsubscribe for', email, err);
    return { statusCode: 500, headers: { 'Content-Type': 'text/html' }, body: page("Something went wrong recording your request — please email sales@woowoo.world and we'll remove you manually.") };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: page(`${email} has been unsubscribed from WooWoo World campaign emails.`)
  };
};
