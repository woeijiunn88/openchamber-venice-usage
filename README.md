# openchamber-venice-usage

OpenChamber extension: a right-rail panel with your Venice account balance,
spend and recent billing ledger, plus a Work Status row set and per-chat cost.

## Requirements

- OpenChamber 2.0.1 or newer (the manifest asks for `>=2.0.1`).
- A Venice **admin** API key. Inference keys can call models but cannot read
  billing, so the panel would show a 403 banner instead of numbers.
- Node 22+ only for building; the built files run inside OpenChamber.

## What it shows

A glance header that stays put across panes: the refresh stamp at the top
right, then balance, the current chat, and today / yesterday / 7-day /
30-day totals. The key tier lives in the Limits pane, not the header, because
it describes access rather than spend.

Then five panes on native kit tabs:

- **Usage** — spend for the selected range, peak day, average per day, a
  30-day run-rate, a daily table (date, tokens in/out/cache, spend; every day
  of the range, scrolling inside a seven-row card), spend split by type
  (text / image / video), and the top three models. The header
  also carries today and yesterday side by side. No chart: a single video
  charge dominates any bar or line scale, and a per-row share only repeated
  the amounts, so the table carries the numbers alone.
- Efficiency cells under the daily table:
  - `CACHE HIT` — cache-read tokens / (input + cache-read).
  - `$ / 1M TOKENS` — LLM spend divided by LLM millions of tokens.
  - `$ / REQUEST` — range spend divided by distinct `inferenceDetails.requestId`
    values in the ledger, so the input/output/cache rows of one call count once.
- Tokens are not in the analytics endpoint, so the service derives them from
  the billing ledger: `units` on `*-mtoken` SKUs are millions of tokens.
- **Models** — every model with its share, unit count and token split
  (input / output / cache), followed by the same range split by API key.
- **Sessions** — Venice spend per chat, from OpenCode's database: call count,
  last activity and recorded cost. Click opens the chat, right-click copies
  the session id. Labelled "OpenCode estimate": Venice's billing API has no
  session id, so these figures are not the billed amounts.
- **Ledger** — the newest charges with their SKU, the largest charge on the
  page, and a count when the scan saw more than it returned.
- **Limits** — tier, access, model count, rate-limit hits, next epoch, and a
  sample of RPM/TPM.

Range is a `mountSelect` ("Last 7 / 30 / 90 days"), the same control
OpenChamber's own usage view uses. The header totals stay at today / 7d / 30d
no matter which range the pane uses.

Values are USD. Venice buckets usage by UTC date, so day labels are UTC.

## Hover text

Every figure that is derived rather than printed by the API carries its formula
in a tooltip:

- `SPENT` — range, peak day, and the 10-minute cache note.
- `AVG / DAY` — spend ÷ days, zero-spend days included.
- `RUN-RATE` — per-day average × 30, labelled as extrapolation.
- `CACHE HIT` — cache ÷ (input + cache) with both numbers filled in.
- `$ / 1M TOKENS` — text spend ÷ text millions, media excluded.
- `$ / REQUEST` — spend ÷ distinct request ids, noting that one call bills several rows.
- Spend-by-type rows — amount, share, and whether the type bills per token or per unit.
- Model rows — spend, units, and input/output/cache split.
- Limits rows — what the model count, rate-limit hits and epoch mean, and each
  model's RPM/TPM.
- Ledger rows — full timestamp, SKU, quantity × unit price, computed amount and
  the request id that produced the charge.

## This chat

A dim line under the balance, visible on every pane: `CHAT` and the cost as
OpenCode recorded it, filtered to `providerID === 'venice'`. The chat title is
hover-only, along with the session id and token split. A chat with no billed
calls reads `CHAT  no Venice usage` with no amount.
Hovering raises it to full opacity and shows tokens in/out/cache plus the
session id in the tooltip.

- Click, or focus and press Enter/Space, to open the chat (`host.openSession`,
  granted by the sessions capability).
- Right-click, Shift+F10 or the context-menu key copies the session id with a
  toast.
- If `opencode.db` cannot be read, the line reads `chat data unavailable`
  instead of sitting on `…`.
- The figure is "OpenCode accounting" on purpose: Venice's ledger has no
  session id, so it can drift from what Venice billed.

Data comes from `~/.local/share/opencode/opencode.db` (`session_message`),
opened read-only by the service.

## Work Status section

`contributes.statusSection.source` points the host at `GET /status`, so the
chat's Work Status card is drawn by the host (no iframe, no second bundle).
Rows: Balance (badge only when the key cannot spend), Today, Yesterday and
7 days. No chart, and no visible sub-values: at 96 px the host chart was
dominated by two charge days, and the per-day figure moved into the tooltip.
Each row carries a tooltip — the host shows it on the row label.

- Balance: prepaid or blocked, plus the 10-minute cache note.
- Today: UTC date, charge count, tokens in/out/cache.
- Yesterday: date and charge count, or "no billed calls".
- 7 days: date range, per-day average, active days, peak day. A Refresh header
  control posts to the same path and clears the cache. The answer is validated
  against `guestStatusViewSchema`; polling is 60 s and reads the spend-only
  summary, so it does not scan the ledger.

## API key

The service reads the key itself; the sandboxed panel never sees it.

1. `VENICE_API_KEY` in the service environment, if set.
2. Otherwise `mcp.servers.venice.environment.VENICE_API_KEY` in
   `$XDG_CONFIG_HOME/opencode/opencode.json` (default `~/.config/opencode`).

The billing endpoints need an **admin** key. An inference-only key gets a 403
and the panel says so.

## Install

1. Build once: `npm install && npm run build` (the repo ships built `panel/main.js`
   and `service/main.js`, so this is only needed after editing sources).
2. OpenChamber → Settings → Extensions.
3. In **Folder, ZIP, or URL**, either paste this directory's absolute path or the
   GitHub URL of this repository.
4. Approve the extension. It asks for the local **service** and **sessions**
   capabilities; sessions is what lets a chat row open its session.

Folder installs run this directory directly, so the edit loop is:
change `panel/main.ts` or `service/main.ts` → `npm run build` → reload the
extension (or reopen the panel).

## Layout

```
panel/     iframe UI: connectHost + host.serviceRequest
service/   loopback HTTP server: /health /balance /key /summary /ledger
build.mjs  esbuild: panel as IIFE, service as CJS
```

Service routes:

| Route | Query | Upstream |
|---|---|---|
| `/balance` | — | `/v1/billing/balance` |
| `/key` | — | `/v1/api_keys/rate_limits` |
| `/summary` | `days` 1..90 | `/v1/billing/usage-analytics?lookback=Nd` |
| `/ledger` | `limit` 1..200, `days` 1..90 | `/v1/billing/usage-history?pageSize=1000&startTimestamp=&endTimestamp=` |
| `/sessions` | `days` 1..365, `limit` 1..100 | local `opencode.db`, Venice-tagged messages, subagents rolled into their root |
| `/session` | `id=ses_…` | local `opencode.db`, Venice-tagged messages only |
| `/status` | — | derived from `/summary` + `/balance`, host-drawn card |

The summary is cached in-process for 60 seconds. Venice itself caches
analytics for 10 minutes, so a faster poll would only re-read the same numbers.

## Upstream quirks this code handles

- Date range parameters are `startDate` / `endDate` (camelCase). Snake case is
  silently ignored and you get the default 7-day window.
- `pageSize` must be **at least 10**. `page_size` and `limit` are rejected.
- `usage-history` returns rows in ascending timestamp order, so the service
  keeps the tail and reverses it for the panel.
- Analytics answers grow with the range (about 61 KB at 90 days). Responses are
  read whole; only the MCP tool truncates them.

## Not included

Full-screen page, slash commands, per-message cost. Venice's ledger carries
`inferenceDetails.requestId`, but OpenCode messages do not expose a matching
id, so attributing a single chat message would be guesswork.

## Troubleshooting

- **403 / "admin key" banner** — the key can call models but not billing.
- **No key** — set `VENICE_API_KEY`, or add it to the Venice MCP entry in
  `opencode.json` as described above.
- **Stale numbers** — Venice caches analytics for 10 minutes; the panel caches
  for 60 seconds. The refresh control clears the local cache only.
- **Rail icon not changing** — manifest edits need an extension reload, not a
  panel reload.

## Icon

The rail icon is `icon.svg`, the Venice emblem taken from the inline `<svg>`
on venice.ai (viewBox `0 0 79 89`) and wrapped in a 24×24 box so the rail
cannot stretch it. Panel chrome uses Remixicon glyphs from the host set — the
refresh control is `loop-right`.

## Dev

```bash
npm run build
npm run typecheck

# run the service alone
OPENCHAMBER_SERVICE_PORT=3999 OPENCHAMBER_SERVICE_TOKEN=dev node service/main.js
curl -s -H 'Authorization: Bearer dev' http://127.0.0.1:3999/balance
```
