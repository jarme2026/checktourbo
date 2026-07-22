// ChecklistState: a Durable Object holds the sheet + all progress marks for
// this project. Cloudflare guarantees requests to the SAME Durable Object
// are handled one at a time, in order — so two people incrementing the same
// row's quantity at the same instant can never overwrite each other. That
// is not something Workers KV can guarantee on its own.
export class ChecklistState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async getDataset() {
    return (await this.state.storage.get('dataset')) || null;
  }

  async getAllTicks() {
    return (await this.state.storage.get('ticks')) || {};
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      // Full sheet + all progress marks (used once, on page load)
      if (url.pathname === '/state' && request.method === 'GET') {
        const dataset = await this.getDataset();
        const ticks = await this.getAllTicks();
        return json({
          headers: dataset ? dataset.headers : [],
          rows: dataset ? dataset.rows : [],
          tickColIndex: dataset ? dataset.tickColIndex : -1,
          qtyColIndex: dataset ? dataset.qtyColIndex : -1,
          ticks
        });
      }

      // Progress marks only — used for the quick refresh after an edit
      if (url.pathname === '/ticks' && request.method === 'GET') {
        const ticks = await this.getAllTicks();
        return json({ ticks });
      }

      // Replace the sheet
      if (url.pathname === '/dataset' && request.method === 'POST') {
        const body = await request.json();
        await this.state.storage.put('dataset', {
          headers: body.headers,
          rows: body.rows,
          tickColIndex: body.tickColIndex,
          qtyColIndex: body.qtyColIndex
        });
        return json({ ok: true });
      }

      // Update one row's progress. Two modes:
      //  - "delta": add/subtract from whatever is currently stored
      //    (used by the +/- quantity stepper — this is the safe,
      //    race-proof way to change a number that others might also
      //    be changing right now)
      //  - "set": force an exact value (used by the simple checkbox,
      //    which only ever has two states)
      // Because this whole function runs inside the Durable Object,
      // Cloudflare guarantees it can never overlap with another call to
      // this same object — the read-modify-write below is safe.
      if (url.pathname === '/tick' && request.method === 'POST') {
        const body = await request.json();
        const ticks = await this.getAllTicks();
        const current = ticks[body.key] || { qty: 0, date: '' };
        const expected = typeof body.expected === 'number' && body.expected > 0
          ? body.expected
          : 1;

        let newQty = body.mode === 'delta'
          ? current.qty + body.value
          : body.value;

        if (newQty < 0) newQty = 0;
        if (newQty > expected) newQty = expected;

        const newDate = newQty > 0 ? new Date().toLocaleDateString('en-US') : '';
        ticks[body.key] = { qty: newQty, date: newDate };
        await this.state.storage.put('ticks', ticks);

        // Return the full ticks map too, so the client can pick up
        // anyone else's changes in this same round trip — no second
        // request needed just to "refresh".
        return json({ ok: true, qty: newQty, date: newDate, ticks });
      }

      // Clear all progress marks
      if (url.pathname === '/reset' && request.method === 'POST') {
        await this.state.storage.put('ticks', {});
        return json({ ok: true });
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  }
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

    if (url.pathname.startsWith('/api/')) {
      // A single, fixed Durable Object instance holds this project's data.
      const id = env.CHECKLIST.idFromName('singleton');
      const stub = env.CHECKLIST.get(id);

      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = url.pathname.slice('/api'.length) || '/';
      const forwardReq = new Request(forwardUrl.toString(), request);
      return stub.fetch(forwardReq);
    }

    // Everything else: serve the static site
    return env.ASSETS.fetch(request);
  }
};
