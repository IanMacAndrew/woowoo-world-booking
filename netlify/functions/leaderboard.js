const { getStore } = require('./_blobs');
const { cohortsData } = require('./_pricing');

function tierLabelFor(count) {
  const tier = cohortsData.commissionTiers.find((t) => count >= t.min && count <= t.max);
  let label = tier ? `${Math.round(tier.rate * 100)}%` : '—';
  if (cohortsData.commissionOverageThreshold && count > cohortsData.commissionOverageThreshold) {
    label += ` + ${Math.round((cohortsData.commissionOverageBonus || 0) * 100)}% overage`;
  }
  return label;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const store = getStore('bookings');
  const { blobs } = await store.list({ prefix: 'rep-eligible-count:' });

  const standings = [];
  for (const b of blobs) {
    const repCode = b.key.replace('rep-eligible-count:', '');
    const raw = await store.get(b.key);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count > 0) {
      standings.push({ repCode, eligibleDelegateCount: count, currentTier: tierLabelFor(count) });
    }
  }

  standings.sort((a, b) => b.eligibleDelegateCount - a.eligibleDelegateCount);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ standings })
  };
};
