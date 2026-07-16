async function getDataset(env) {
  const raw = await env.DATA.get('dataset');
  return raw ? JSON.parse(raw) : null;
}

async function getAllTicks(env) {
  const ticks = {};
  const allKeys = [];
  let cursor;
  for (;;) {
    const list = await env.DATA.list({ prefix: 'tick:', cursor });
    allKeys.push(...list.keys);
    if (list.list_complete) break;
    cursor = list.cursor;
  }
  // Read every tick in parallel instead of one at a time — this is the
  // biggest speed win when there are many rows.
  const results = await Promise.all(allKeys.map(k => env.DATA.get(k.name)));
  allKeys.forEach((k, i) => {
    if (results[i]) ticks[k.name.slice('tick:'.length)] = JSON.parse(results[i]);
  });
  return ticks;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      // Public: full sheet + all progress marks (used once, on page load)
      if (url.pathname === '/api/state' && request.method === 'GET') {
        const dataset = await getDataset(env);
        const ticks = await getAllTicks(env);
        return json({
          headers: dataset ? dataset.headers : [],
          rows: dataset ? dataset.rows : [],
          tickColIndex: dataset ? dataset.tickColIndex : -1,
          qtyColIndex: dataset ? dataset.qtyColIndex : -1,
          ticks
        });
      }

      // Public: progress marks ONLY — small and fast, used for polling
      if (url.pathname === '/api/ticks' && request.method === 'GET') {
        const ticks = await getAllTicks(env);
        return json({ ticks });
      }

      // Replace the sheet — its own key, never contends with tick writes
      if (url.pathname === '/api/dataset' && request.method === 'POST') {
        const body = await request.json();
        await env.DATA.put('dataset', JSON.stringify({
          headers: body.headers,
          rows: body.rows,
          tickColIndex: body.tickColIndex,
          qtyColIndex: body.qtyColIndex
        }));
        return json({ ok: true });
      }

      // Update one row's progress — each row has its own key, so different
      // rows never collide with each other or with a dataset save
      if (url.pathname === '/api/tick' && request.method === 'POST') {
        const body = await request.json();
        await env.DATA.put('tick:' + body.key, JSON.stringify({
          qty: body.qty,
          date: body.date
        }));
        return json({ ok: true });
      }

      // Clear all progress marks
      if (url.pathname === '/api/reset' && request.method === 'POST') {
        let cursor;
        for (;;) {
          const list = await env.DATA.list({ prefix: 'tick:', cursor });
          await Promise.all(list.keys.map(k => env.DATA.delete(k.name)));
          if (list.list_complete) break;
          cursor = list.cursor;
        }
        return json({ ok: true });
      }

      // Everything else: serve the static site
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  }
};
