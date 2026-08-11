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

  async getAllNotes() {
    return (await this.state.storage.get('notes')) || {};
  }

  // Mirrors the client's parseExpectedQty logic, so completion can be
  // checked authoritatively on the server (never trust the client alone
  // for something that triggers sending an email).
  parseExpectedQty(row, qtyColIndex) {
    if (qtyColIndex == null || qtyColIndex < 0) return 1;
    const raw = row[qtyColIndex];
    if (raw === undefined || raw === null || String(raw).trim() === '') return 1;
    const normalized = String(raw).trim().replace(/\./g, '').replace(',', '.').replace(/[^0-9.\-]/g, '');
    const n = Math.round(Math.abs(parseFloat(normalized)));
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  rowKey(row) {
    const str = row.map(c => String(c ?? '').trim().toLowerCase()).join('|');
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return 'r' + (h >>> 0).toString(36);
  }

  async isFullyComplete() {
    const dataset = await this.getDataset();
    if (!dataset || !dataset.rows || !dataset.rows.length) return false;
    const ticks = await this.getAllTicks();
    const seen = {};
    for (const row of dataset.rows) {
      let base = this.rowKey(row);
      seen[base] = (seen[base] || 0) + 1;
      const key = seen[base] > 1 ? base + 'd' + seen[base] : base;
      const expected = this.parseExpectedQty(row, dataset.qtyColIndex);
      const done = ticks[key] ? (ticks[key].qty || 0) : 0;
      if (done < expected) return false;
    }
    return true;
  }

  async buildCsv() {
    const dataset = await this.getDataset();
    const ticks = await this.getAllTicks();
    const notes = await this.getAllNotes();
    if (!dataset) return '';

    const escape = (val) => {
      const s = String(val ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const seen = {};
    const lines = [];
    lines.push([...dataset.headers, 'Status', 'Notes'].map(escape).join(','));
    dataset.rows.forEach(row => {
      let base = this.rowKey(row);
      seen[base] = (seen[base] || 0) + 1;
      const key = seen[base] > 1 ? base + 'd' + seen[base] : base;
      const expected = this.parseExpectedQty(row, dataset.qtyColIndex);
      const state = ticks[key];
      const done = state ? (state.qty || 0) : 0;
      const status = done >= expected ? 'Done' : (done > 0 ? `Partial (${done}/${expected})` : 'Not done');
      const note = notes[key] || '';
      lines.push([...row, status, note].map(escape).join(','));
    });
    return lines.join('\r\n');
  }

  async sendReportEmail() {
    const csv = await this.buildCsv();
    const recipients = (this.env.REPORT_RECIPIENTS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (!recipients.length) {
      return { ok: false, error: 'No REPORT_RECIPIENTS configured' };
    }
    if (!this.env.RESEND_API_KEY) {
      const visibleKeys = Object.keys(this.env || {}).join(', ') || '(none)';
      return { ok: false, error: 'No RESEND_API_KEY configured. Bindings visible to this Durable Object: [' + visibleKeys + ']' };
    }

    const bytes = new TextEncoder().encode(csv);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + this.env.RESEND_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Check List Tour <onboarding@resend.dev>',
        to: recipients,
        subject: 'Checklist complete — all items confirmed',
        text: 'The checklist has been fully checked off. The updated sheet is attached as a CSV.',
        attachments: [
          { filename: 'checklist-complete.csv', content: base64 }
        ]
      })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, error: 'Resend API error (' + res.status + '): ' + errText };
    }
    return { ok: true };
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      // Full sheet + all progress marks + notes (used once, on page load)
      if (url.pathname === '/state' && request.method === 'GET') {
        const dataset = await this.getDataset();
        const ticks = await this.getAllTicks();
        const notes = await this.getAllNotes();
        return json({
          headers: dataset ? dataset.headers : [],
          rows: dataset ? dataset.rows : [],
          tickColIndex: dataset ? dataset.tickColIndex : -1,
          qtyColIndex: dataset ? dataset.qtyColIndex : -1,
          ticks,
          notes
        });
      }

      // Progress marks + notes only — used for the quick refresh after an edit
      if (url.pathname === '/ticks' && request.method === 'GET') {
        const ticks = await this.getAllTicks();
        const notes = await this.getAllNotes();
        return json({ ticks, notes });
      }

      // Replace the sheet — starts a new cycle, so a fresh report can be
      // sent next time this list is fully checked off
      if (url.pathname === '/dataset' && request.method === 'POST') {
        const body = await request.json();
        await this.state.storage.put('dataset', {
          headers: body.headers,
          rows: body.rows,
          tickColIndex: body.tickColIndex,
          qtyColIndex: body.qtyColIndex
        });
        await this.state.storage.put('reportSent', false);
        return json({ ok: true });
      }

      // Update one row's progress. Two modes:
      //  - "delta": add/subtract from whatever is currently stored
      //  - "set": force an exact value (used by the simple checkbox)
      // This whole function runs inside the Durable Object, so Cloudflare
      // guarantees it can never overlap with another call to this same
      // object — the read-modify-write below is safe.
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

        return json({ ok: true, qty: newQty, date: newDate, ticks });
      }

      // Set or clear a note for one row (admin only, via the UI)
      if (url.pathname === '/note' && request.method === 'POST') {
        const body = await request.json();
        const notes = await this.getAllNotes();
        if (body.note && body.note.trim()) {
          notes[body.key] = body.note.trim();
        } else {
          delete notes[body.key];
        }
        await this.state.storage.put('notes', notes);
        return json({ ok: true, notes });
      }

      // Clear all progress marks and notes — starts a new cycle
      if (url.pathname === '/reset' && request.method === 'POST') {
        await this.state.storage.put('ticks', {});
        await this.state.storage.put('notes', {});
        await this.state.storage.put('reportSent', false);
        return json({ ok: true });
      }

      // Called by the client whenever it notices the list just became
      // 100% complete. Safe to call more than once: the Durable Object
      // only ever actually sends the email the first time per cycle,
      // even if two people's tabs both notice completion at once.
      // With { force: true } (the admin's "send test report" button), it
      // skips the completion/already-sent checks entirely — useful for
      // testing the email pipeline without checking off a whole list.
      if (url.pathname === '/send-report' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (err) {}

        if (!body.force) {
          const alreadySent = await this.state.storage.get('reportSent');
          if (alreadySent) {
            return json({ ok: true, skipped: true, reason: 'already sent' });
          }
          const complete = await this.isFullyComplete();
          if (!complete) {
            return json({ ok: true, skipped: true, reason: 'not complete' });
          }
        }

        const result = await this.sendReportEmail();
        if (!result.ok) {
          return json({ ok: false, error: result.error }, 502);
        }
        if (!body.force) {
          await this.state.storage.put('reportSent', true);
        }
        return json({ ok: true, sent: true });
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
