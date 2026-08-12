// ChecklistState: a Durable Object holds the sheet + all progress marks for
// this project. Cloudflare guarantees requests to the SAME Durable Object
// are handled one at a time, in order.

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

  parseExpectedQty(row, qtyColIndex) {
    if (qtyColIndex == null || qtyColIndex < 0) {
      return 1;
    }

    const raw = row[qtyColIndex];

    if (
      raw === undefined ||
      raw === null ||
      String(raw).trim() === ''
    ) {
      return 1;
    }

    const normalized = String(raw)
      .trim()
      .replace(/\./g, '')
      .replace(',', '.')
      .replace(/[^0-9.\-]/g, '');

    const n = Math.round(
      Math.abs(
        parseFloat(normalized)
      )
    );

    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  rowKey(row) {
    const str = row
      .map(c => String(c ?? '').trim().toLowerCase())
      .join('|');

    let h = 0;

    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }

    return 'r' + (h >>> 0).toString(36);
  }

  async isFullyComplete() {
    const dataset = await this.getDataset();

    if (
      !dataset ||
      !dataset.rows ||
      !dataset.rows.length
    ) {
      return false;
    }

    const ticks = await this.getAllTicks();
    const notes = await this.getAllNotes();

    const seen = {};

    for (const row of dataset.rows) {
      let base = this.rowKey(row);

      seen[base] = (seen[base] || 0) + 1;

      const key =
        seen[base] > 1
          ? base + 'd' + seen[base]
          : base;

      const expected = this.parseExpectedQty(
        row,
        dataset.qtyColIndex
      );

      const done = ticks[key]
        ? (ticks[key].qty || 0)
        : 0;

      const note = String(
        notes[key] || ''
      ).trim();

      // A row is resolved if:
      // - the expected quantity was completed, OR
      // - there is a note explaining the issue/unavailability.
      if (
        done < expected &&
        !note
      ) {
        return false;
      }
    }

    return true;
  }

  async buildCsv() {
    const dataset = await this.getDataset();
    const ticks = await this.getAllTicks();
    const notes = await this.getAllNotes();

    if (!dataset) {
      return '';
    }

    const escape = (val) => {
      const s = String(val ?? '');

      return /[",\n]/.test(s)
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    };

    const seen = {};
    const lines = [];

    lines.push(
      [...dataset.headers, 'Status', 'Notes']
        .map(escape)
        .join(',')
    );

    dataset.rows.forEach(row => {
      let base = this.rowKey(row);

      seen[base] = (seen[base] || 0) + 1;

      const key =
        seen[base] > 1
          ? base + 'd' + seen[base]
          : base;

      const expected = this.parseExpectedQty(
        row,
        dataset.qtyColIndex
      );

      const state = ticks[key];

      const done = state
        ? (state.qty || 0)
        : 0;

      const note = String(
        notes[key] || ''
      ).trim();

      let status;

      if (done >= expected) {
        status = 'Done';
      } else if (note) {
        status = 'Not available / noted';
      } else if (done > 0) {
        status = `Partial (${done}/${expected})`;
      } else {
        status = 'Not done';
      }

      lines.push(
        [...row, status, note]
          .map(escape)
          .join(',')
      );
    });

    return lines.join('\r\n');
  }

  async getResendApiKey() {
    const binding = this.env.RESEND_API_KEY;

    if (!binding) {
      return null;
    }

    // Cloudflare Secrets Store
    if (typeof binding.get === 'function') {
      return await binding.get();
    }

    // Fallback in case it is configured as a normal Worker secret.
    if (typeof binding === 'string') {
      return binding;
    }

    return null;
  }

  async sendReportEmail() {
    const csv = await this.buildCsv();

    const recipients = (
      this.env.REPORT_RECIPIENTS || ''
    )
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (!recipients.length) {
      return {
        ok: false,
        error: 'No REPORT_RECIPIENTS configured'
      };
    }

    const apiKey =
      await this.getResendApiKey();

    if (!apiKey) {
      return {
        ok: false,
        error: 'No RESEND_API_KEY configured'
      };
    }

    const bytes =
      new TextEncoder().encode(csv);

    let binary = '';

    for (
      let i = 0;
      i < bytes.length;
      i++
    ) {
      binary += String.fromCharCode(
        bytes[i]
      );
    }

    const base64 = btoa(binary);

    const res = await fetch(
      'https://api.resend.com/emails',
      {
        method: 'POST',

        headers: {
          'Authorization':
            'Bearer ' + apiKey,

          'content-type':
            'application/json'
        },

        body: JSON.stringify({
          from:
            'Check List Tour <onboarding@resend.dev>',

          to: recipients,

          subject:
            'Checklist complete — all items confirmed',

          text:
            'The checklist has been fully checked off. ' +
            'The updated sheet is attached as a CSV.',

          attachments: [
            {
              filename:
                'checklist-complete.csv',

              content:
                base64
            }
          ]
        })
      }
    );

    if (!res.ok) {
      const errText =
        await res.text().catch(
          () => ''
        );

      return {
        ok: false,
        error:
          'Resend API error (' +
          res.status +
          '): ' +
          errText
      };
    }

    return {
      ok: true
    };
  }

  async fetch(request) {
    const url =
      new URL(request.url);

    try {

      // =================================================
      // GET /state
      // Full sheet + progress + notes.
      // Used once when the page loads.
      // =================================================

      if (
        url.pathname === '/state' &&
        request.method === 'GET'
      ) {
        const dataset =
          await this.getDataset();

        const ticks =
          await this.getAllTicks();

        const notes =
          await this.getAllNotes();

        return json({
          headers:
            dataset
              ? dataset.headers
              : [],

          rows:
            dataset
              ? dataset.rows
              : [],

          tickColIndex:
            dataset
              ? dataset.tickColIndex
              : -1,

          qtyColIndex:
            dataset
              ? dataset.qtyColIndex
              : -1,

          ticks,
          notes
        });
      }

      // =================================================
      // GET /ticks
      // Lightweight refresh.
      // =================================================

      if (
        url.pathname === '/ticks' &&
        request.method === 'GET'
      ) {
        const ticks =
          await this.getAllTicks();

        const notes =
          await this.getAllNotes();

        return json({
          ticks,
          notes
        });
      }

      // =================================================
      // POST /dataset
      // Store or replace spreadsheet.
      // =================================================

      if (
        url.pathname === '/dataset' &&
        request.method === 'POST'
      ) {
        const body =
          await request.json();

        await this.state.storage.put(
          'dataset',
          {
            headers:
              body.headers,

            rows:
              body.rows,

            tickColIndex:
              body.tickColIndex,

            qtyColIndex:
              body.qtyColIndex
          }
        );

        // New or replaced sheet = new report cycle.
        await this.state.storage.put(
          'reportSent',
          false
        );

        return json({
          ok: true
        });
      }

      // =================================================
      // POST /tick
      // Atomic progress update.
      // =================================================

      if (
        url.pathname === '/tick' &&
        request.method === 'POST'
      ) {
        const body =
          await request.json();

        const ticks =
          await this.getAllTicks();

        const current =
          ticks[body.key]
          ||
          {
            qty: 0,
            date: ''
          };

        const expected =
          typeof body.expected === 'number' &&
          body.expected > 0
            ? body.expected
            : 1;

        let newQty;

        if (
          body.mode === 'delta'
        ) {
          newQty =
            current.qty +
            Number(
              body.value || 0
            );
        } else {
          newQty =
            Number(
              body.value || 0
            );
        }

        if (newQty < 0) {
          newQty = 0;
        }

        if (
          newQty > expected
        ) {
          newQty =
            expected;
        }

        const newDate =
          newQty > 0
            ? new Date()
                .toLocaleDateString(
                  'en-US'
                )
            : '';

        ticks[body.key] = {
          qty:
            newQty,

          date:
            newDate
        };

        await this.state.storage.put(
          'ticks',
          ticks
        );

        return json({
          ok: true,
          qty:
            newQty,
          date:
            newDate,
          ticks
        });
      }

      // =================================================
      // POST /note
      // Save or remove one note.
      // =================================================

      if (
        url.pathname === '/note' &&
        request.method === 'POST'
      ) {
        const body =
          await request.json();

        const notes =
          await this.getAllNotes();

        const cleanNote =
          String(
            body.note || ''
          ).trim();

        if (cleanNote) {
          notes[body.key] =
            cleanNote;
        } else {
          delete notes[
            body.key
          ];
        }

        await this.state.storage.put(
          'notes',
          notes
        );

        return json({
          ok: true,
          notes
        });
      }

      // =================================================
      // POST /reset
      // Clear progress + notes.
      // =================================================

      if (
        url.pathname === '/reset' &&
        request.method === 'POST'
      ) {
        await this.state.storage.put(
          'ticks',
          {}
        );

        await this.state.storage.put(
          'notes',
          {}
        );

        await this.state.storage.put(
          'reportSent',
          false
        );

        return json({
          ok: true
        });
      }

      // =================================================
      // POST /send-report
      //
      // Normal automatic request:
      //   checklist must be fully resolved.
      //
      // force:true:
      //   manual admin test.
      // =================================================

      if (
        url.pathname === '/send-report' &&
        request.method === 'POST'
      ) {
        let body = {};

        try {
          body =
            await request.json();
        } catch (err) {
          body = {};
        }

        const force =
          body.force === true;

        if (!force) {
          const alreadySent =
            await this.state.storage.get(
              'reportSent'
            );

          if (
            alreadySent
          ) {
            return json({
              ok: true,
              skipped: true,
              reason:
                'already sent'
            });
          }

          const complete =
            await this.isFullyComplete();

          if (!complete) {
            return json({
              ok: true,
              skipped: true,
              reason:
                'not complete'
            });
          }
        }

        const result =
          await this.sendReportEmail();

        if (!result.ok) {
          return json(
            {
              ok: false,
              error:
                result.error
            },
            502
          );
        }

        // Test email must not mark the real report as sent.
        if (!force) {
          await this.state.storage.put(
            'reportSent',
            true
          );
        }

        return json({
          ok: true,
          sent: true,
          test:
            force
        });
      }

      return json(
        {
          error:
            'not found'
        },
        404
      );

    } catch (err) {

      return json(
        {
          error:
            String(
              err &&
              err.message
                ? err.message
                : err
            )
        },
        500
      );
    }
  }
}


function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        'content-type':
          'application/json'
      }
    }
  );
}


// =====================================================
// MAIN WORKER
// =====================================================

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    const url =
      new URL(request.url);

    if (
      url.pathname.startsWith(
        '/api/'
      )
    ) {

      // IMPORTANT:
      // Keep the original fixed Durable Object name.
      // Changing this name would create a different
      // storage/database.
      const id =
        env.CHECKLIST.idFromName(
          'singleton'
        );

      const stub =
        env.CHECKLIST.get(id);

      const forwardUrl =
        new URL(request.url);

      forwardUrl.pathname =
        url.pathname.slice(
          '/api'.length
        )
        ||
        '/';

      const forwardReq =
        new Request(
          forwardUrl.toString(),
          request
        );

      return stub.fetch(
        forwardReq
      );
    }

    // Everything else is served from the static assets.
    return env.ASSETS.fetch(
      request
    );
  }
};
