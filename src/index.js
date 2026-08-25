// =====================================================
// SHARED CHECKLIST WORKER
// Used by checktourup and checktourbo
//
// Responsibilities:
// - persistent shared checklist state (Durable Object)
// - multi-device progress synchronization
// - per-item checker attribution
// - notes / quantities
// - final CSV report by email
// =====================================================

function normalizeCheckerName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 50);
}

export class ChecklistState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async getDataset() {
    return (
      await this.state.storage.get(
        "dataset"
      )
    ) || null;
  }

  async getAllTicks() {
    return (
      await this.state.storage.get(
        "ticks"
      )
    ) || {};
  }

  async getAllNotes() {
    return (
      await this.state.storage.get(
        "notes"
      )
    ) || {};
  }


  async getAllCheckedBy() {
    return (
      await this.state.storage.get(
        "checkedByRows"
      )
    ) || {};
  }


  parseExpectedQty(
    row,
    qtyColIndex
  ) {
    if (
      qtyColIndex == null ||
      qtyColIndex < 0
    ) {
      return 1;
    }

    const raw =
      row[qtyColIndex];

    if (
      raw === undefined ||
      raw === null ||
      String(raw).trim() === ""
    ) {
      return 1;
    }

    const normalized =
      String(raw)
        .trim()
        .replace(/\./g, "")
        .replace(",", ".")
        .replace(
          /[^0-9.\-]/g,
          ""
        );

    const n =
      Math.round(
        Math.abs(
          parseFloat(
            normalized
          )
        )
      );

    return (
      Number.isFinite(n) &&
      n > 0
    )
      ? n
      : 1;
  }

  rowKey(row) {
    const str =
      row
        .map(
          c =>
            String(
              c ?? ""
            )
              .trim()
              .toLowerCase()
        )
        .join("|");

    let h = 0;

    for (
      let i = 0;
      i < str.length;
      i++
    ) {
      h =
        (
          Math.imul(
            31,
            h
          )
          +
          str.charCodeAt(i)
        )
        |
        0;
    }

    return (
      "r"
      +
      (h >>> 0)
        .toString(36)
    );
  }

  async isFullyComplete() {
    const dataset =
      await this.getDataset();

    if (
      !dataset ||
      !dataset.rows ||
      !dataset.rows.length
    ) {
      return false;
    }

    const ticks =
      await this.getAllTicks();

    const notes =
      await this.getAllNotes();

    const seen = {};

    for (
      const row
      of
      dataset.rows
    ) {
      const base =
        this.rowKey(
          row
        );

      seen[base] =
        (seen[base] || 0)
        +
        1;

      const key =
        seen[base] > 1
          ? base
            +
            "d"
            +
            seen[base]
          : base;

      const expected =
        this.parseExpectedQty(
          row,
          dataset.qtyColIndex
        );

      const done =
        ticks[key]
          ? (
              ticks[key].qty
              ||
              0
            )
          : 0;

      const note =
        String(
          notes[key]
          ||
          ""
        ).trim();

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
    const dataset =
      await this.getDataset();

    const ticks =
      await this.getAllTicks();

    const notes =
      await this.getAllNotes();

    const checkedByRows =
      await this.getAllCheckedBy();

    if (!dataset) {
      return "";
    }

    const escape =
      value => {
        const s =
          String(
            value ?? ""
          );

        return /[",\n]/.test(s)
          ? '"'
            +
            s.replace(
              /"/g,
              '""'
            )
            +
            '"'
          : s;
      };

    const seen = {};
    const lines = [];

    lines.push(
      [
        ...dataset.headers,
        "Status",
        "Notes",
        "Checked By"
      ]
        .map(
          escape
        )
        .join(",")
    );

    dataset.rows.forEach(
      row => {
        const base =
          this.rowKey(
            row
          );

        seen[base] =
          (seen[base] || 0)
          +
          1;

        const key =
          seen[base] > 1
            ? base
              +
              "d"
              +
              seen[base]
            : base;

        const expected =
          this.parseExpectedQty(
            row,
            dataset.qtyColIndex
          );

        const tickState =
          ticks[key];

        const done =
          tickState
            ? (
                tickState.qty
                ||
                0
              )
            : 0;

        const note =
          String(
            notes[key]
            ||
            ""
          ).trim();

        let status;

        if (
          done >= expected
        ) {
          status =
            "Done";
        }
        else if (
          note
        ) {
          status =
            "Not available / noted";
        }
        else if (
          done > 0
        ) {
          status =
            `Partial (${done}/${expected})`;
        }
        else {
          status =
            "Not done";
        }

        lines.push(
          [
            ...row,
            status,
            note,
            checkedByRows[key] || ""
          ]
            .map(
              escape
            )
            .join(",")
        );
      }
    );

    return lines.join(
      "\r\n"
    );
  }

  async getResendApiKey() {
    const binding =
      this.env.RESEND_API_KEY;

    if (!binding) {
      return null;
    }

    if (
      typeof binding.get ===
      "function"
    ) {
      return await binding.get();
    }

    if (
      typeof binding ===
      "string"
    ) {
      return binding;
    }

    return null;
  }

  async sendReportEmail(
    checkedBy
  ) {
    const csv =
      await this.buildCsv();

    const recipients =
      (
        this.env.REPORT_RECIPIENTS
        ||
        ""
      )
        .split(",")
        .map(
          s =>
            s.trim()
        )
        .filter(
          Boolean
        );

    if (
      !recipients.length
    ) {
      return {
        ok:
          false,
        error:
          "No REPORT_RECIPIENTS configured"
      };
    }

    const apiKey =
      await this.getResendApiKey();

    if (
      !apiKey
    ) {
      return {
        ok:
          false,
        error:
          "No RESEND_API_KEY configured"
      };
    }

    const bytes =
      new TextEncoder()
        .encode(
          csv
        );

    let binary = "";

    for (
      let i = 0;
      i < bytes.length;
      i++
    ) {
      binary +=
        String.fromCharCode(
          bytes[i]
        );
    }

    const base64 =
      btoa(
        binary
      );

    const safeChecker =
      String(
        checkedBy
        ||
        ""
      ).trim();

    const subjectSuffix =
      safeChecker
        ? " — checked by " + safeChecker
        : "";

    const textCheckerLine =
      safeChecker
        ? "\n\nChecked by: " + safeChecker
        : "";

    const res =
      await fetch(
        "https://api.resend.com/emails",
        {
          method:
            "POST",

          headers: {
            Authorization:
              "Bearer "
              +
              apiKey,

            "content-type":
              "application/json"
          },

          body:
            JSON.stringify({
              from:
                "Check List Tour <onboarding@resend.dev>",

              to:
                recipients,

              subject:
                "Checklist complete"
                +
                subjectSuffix,

              text:
                "The checklist has been fully checked off."
                +
                textCheckerLine
                +
                "\n\nThe updated sheet is attached as a CSV.",

              attachments: [
                {
                  filename:
                    "checklist-complete.csv",

                  content:
                    base64
                }
              ]
            })
        }
      );

    if (
      !res.ok
    ) {
      const errText =
        await res
          .text()
          .catch(
            () => ""
          );

      return {
        ok:
          false,

        error:
          "Resend API error ("
          +
          res.status
          +
          "): "
          +
          errText
      };
    }

    return {
      ok:
        true
    };
  }

  async fetch(
    request
  ) {
    const url =
      new URL(
        request.url
      );

    try {

      if (
        url.pathname ===
          "/state"
        &&
        request.method ===
          "GET"
      ) {
        const dataset =
          await this.getDataset();

        const ticks =
          await this.getAllTicks();

        const notes =
          await this.getAllNotes();

        const checkedByRows =
          await this.getAllCheckedBy();

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

          notes,

          checkedByRows
        });
      }

      if (
        url.pathname ===
          "/ticks"
        &&
        request.method ===
          "GET"
      ) {
        const ticks =
          await this.getAllTicks();

        const notes =
          await this.getAllNotes();

        const checkedByRows =
          await this.getAllCheckedBy();

        return json({
          ticks,
          notes,
          checkedByRows
        });
      }

      if (
        url.pathname ===
          "/dataset"
        &&
        request.method ===
          "POST"
      ) {
        const body =
          await request.json();

        await this.state.storage.put(
          "dataset",
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

        await this.state.storage.put(
          "checkedByRows",
          {}
        );

        await this.state.storage.put(
          "reportSent",
          false
        );

        return json({
          ok:
            true
        });
      }

      if (
        url.pathname ===
          "/tick"
        &&
        request.method ===
          "POST"
      ) {
        const body =
          await request.json();

        const ticks =
          await this.getAllTicks();

        const current =
          ticks[body.key]
          ||
          {
            qty:
              0,

            date:
              ""
          };

        const expected =
          typeof body.expected ===
            "number"
          &&
          body.expected > 0
            ? body.expected
            : 1;

        let newQty;

        if (
          body.mode ===
          "delta"
        ) {
          newQty =
            current.qty
            +
            Number(
              body.value
              ||
              0
            );
        }
        else {
          newQty =
            Number(
              body.value
              ||
              0
            );
        }

        if (
          newQty < 0
        ) {
          newQty =
            0;
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
                  "en-US"
                )
            : "";

        ticks[body.key] = {
          qty:
            newQty,

          date:
            newDate
        };

        await this.state.storage.put(
          "ticks",
          ticks
        );

        const checkedByRows =
          await this.getAllCheckedBy();

        const checkerName =
          normalizeCheckerName(
            body.checkedBy
          );

        const previousQty =
          Number(
            current.qty || 0
          );

        const isComplete =
          newQty >= expected;

        const madePositiveProgress =
          newQty > previousQty;

        if (
          madePositiveProgress
          &&
          checkerName.length >= 2
        ) {
          const existingNames =
            String(
              checkedByRows[body.key] || ""
            )
              .split(",")
              .map(
                name => name.trim()
              )
              .filter(Boolean);

          if (
            !existingNames.includes(
              checkerName
            )
          ) {
            existingNames.push(
              checkerName
            );
          }

          checkedByRows[body.key] =
            existingNames.join(", ");
        }

        // If all progress for the row is removed, clear its attribution.
        if (
          newQty === 0
        ) {
          const notesNow =
            await this.getAllNotes();

          const noteNow =
            String(
              notesNow[body.key] || ""
            ).trim();

          if (
            !noteNow
          ) {
            delete checkedByRows[
              body.key
            ];
          }
        }

        await this.state.storage.put(
          "checkedByRows",
          checkedByRows
        );

        const allComplete =
          isComplete
            ? await this.isFullyComplete()
            : false;

        return json({
          ok:
            true,

          qty:
            newQty,

          date:
            newDate,

          ticks,

          allComplete
        });
      }

      if (
        url.pathname ===
          "/note"
        &&
        request.method ===
          "POST"
      ) {
        const body =
          await request.json();

        const notes =
          await this.getAllNotes();

        const previousNote =
          String(
            notes[body.key]
            ||
            ""
          );

        const cleanNote =
          String(
            body.note
            ||
            ""
          ).trim();

        if (
          cleanNote
        ) {
          notes[body.key] =
            cleanNote;
        }
        else {
          delete notes[
            body.key
          ];
        }

        await this.state.storage.put(
          "notes",
          notes
        );

        const checkedByRows =
          await this.getAllCheckedBy();

        const checkerName =
          normalizeCheckerName(
            body.checkedBy
          );

        if (
          cleanNote
          &&
          checkerName.length >= 2
        ) {
          const existingNames =
            String(
              checkedByRows[body.key] || ""
            )
              .split(",")
              .map(
                name => name.trim()
              )
              .filter(Boolean);

          if (
            !existingNames.includes(
              checkerName
            )
          ) {
            existingNames.push(
              checkerName
            );
          }

          checkedByRows[body.key] =
            existingNames.join(", ");
        }

        if (
          !cleanNote
        ) {
          const ticksNow =
            await this.getAllTicks();

          const qtyNow =
            ticksNow[body.key]
              ? Number(
                  ticksNow[body.key].qty || 0
                )
              : 0;

          if (
            qtyNow === 0
          ) {
            delete checkedByRows[
              body.key
            ];
          }
        }

        await this.state.storage.put(
          "checkedByRows",
          checkedByRows
        );

        const allComplete =
          isComplete
            ? await this.isFullyComplete()
            : false;

        return json({
          ok:
            true,

          notes,

          allComplete
        });
      }

      if (
        url.pathname ===
          "/reset"
        &&
        request.method ===
          "POST"
      ) {
        await this.state.storage.put(
          "ticks",
          {}
        );

        await this.state.storage.put(
          "notes",
          {}
        );

        await this.state.storage.put(
          "checkedByRows",
          {}
        );

        await this.state.storage.put(
          "reportSent",
          false
        );

        return json({
          ok:
            true
        });
      }

      // =================================================
      // SEND REPORT
      //
      // Normal report:
      //   Adrian / Leo / Liviu is REQUIRED.
      //
      // Admin test:
      //   force:true sends with Checked By blank.
      //   It never writes "Test email".
      // =================================================

      if (
        url.pathname ===
          "/send-report"
        &&
        request.method ===
          "POST"
      ) {
        let body = {};

        try {
          body =
            await request.json();
        }
        catch (
          error
        ) {
          body = {};
        }

        const force =
          body.force ===
          true;

        const requestedChecker = normalizeCheckerName(body.checkedBy);
        const checkedBy = force ? '' : requestedChecker;

        if (!force && checkedBy.length < 2) {
          return json(
            { ok: false, error: 'Please enter the name of the person who checked the list.' },
            400
          );
        }

        if (
          !force
        ) {
          const alreadySent =
            await this.state.storage.get(
              "reportSent"
            );

          if (
            alreadySent
          ) {
            return json({
              ok:
                true,

              skipped:
                true,

              reason:
                "already sent"
            });
          }

          const complete =
            await this.isFullyComplete();

          if (
            !complete
          ) {
            return json({
              ok:
                true,

              skipped:
                true,

              reason:
                "not complete"
            });
          }
        }

        const result =
          await this.sendReportEmail(
            checkedBy
          );

        if (
          !result.ok
        ) {
          return json(
            {
              ok:
                false,

              error:
                result.error
            },
            502
          );
        }

        if (
          !force
        ) {
          await this.state.storage.put(
            "reportSent",
            true
          );

          await this.state.storage.put(
            "lastCheckedBy",
            checkedBy
          );
        }

        return json({
          ok:
            true,

          sent:
            true,

          test:
            force,

          checkedBy
        });
      }

      return json(
        {
          error:
            "not found"
        },
        404
      );
    }
    catch (
      err
    ) {
      return json(
        {
          error:
            String(
              err
              &&
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
    JSON.stringify(
      data
    ),
    {
      status,

      headers: {
        "content-type":
          "application/json"
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
      new URL(
        request.url
      );

    if (
      url.pathname.startsWith(
        "/api/"
      )
    ) {
      const id =
        env.CHECKLIST.idFromName(
          "singleton"
        );

      const stub =
        env.CHECKLIST.get(
          id
        );

      const forwardUrl =
        new URL(
          request.url
        );

      forwardUrl.pathname =
        url.pathname.slice(
          "/api".length
        )
        ||
        "/";

      const forwardReq =
        new Request(
          forwardUrl.toString(),
          request
        );

      return stub.fetch(
        forwardReq
      );
    }

    // The checker selection now lives directly in dist/index.html.
    // No checker-prompt.js injection is needed.
    return env.ASSETS.fetch(request);
  }
};
