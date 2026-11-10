# Venice Usage for OpenChamber

A right-rail panel and Work Status card for Venice billing: balance, spend,
tokens, per-chat cost, recent charges and rate limits.

## Features

- **Glance header** — balance, current chat cost, today / yesterday / 7-day /
  30-day totals, refresh stamp.
- **Usage** — spend for the selected range, peak day, average per day, 30-day
  run-rate, a daily table with tokens in/out/cache, spend by type, top models,
  and efficiency cells: cache hit, cost per 1M tokens, cost per request.
- **Models** — per-model share, units and token split, then the same range by
  API key.
- **Sessions** — Venice spend per chat, with click to open and right-click to
  copy the session id.
- **Ledger** — newest charges with SKU, unit price and request id in the row
  tooltip.
- **Limits** — tier, access, model count, rate-limit hits, next epoch and a
  sample of per-model RPM/TPM.
- **Work Status** — Balance, Today, Yesterday and 7 days, drawn by the host.

Every derived figure explains its formula on hover.

## Requirements

- OpenChamber 2.0.1 or newer.
- A Venice **admin** API key. Inference keys can call models but cannot read
  billing.
- Node 22+ for building only; the built bundle runs inside OpenChamber.

## Installation

Pick one:

1. **Release ZIP** — download `openchamber-venice-usage-0.1.0.zip` from the
   releases page and paste its URL, or the downloaded file path, into
   **Folder, ZIP, or URL**.
2. **GitHub** — paste `https://github.com/woeijiunn88/openchamber-venice-usage`
   for a Git install that can check for updates.
3. **Local folder** — build with `npm install && npm run build`, then paste this
   directory's absolute path.

Then open **Settings → Extensions** and approve the extension. It requests two
capabilities:

- **service** — start the local billing service;
- **sessions** — open a chat from the panel.

Built files are committed, so building is only needed after editing sources.

## Usage

- **Range** — a select with last 7, 30 or 90 days. It drives the KPIs, daily
  table, models, sessions and ledger.
- **Chat line** — `CHAT $0.1154` under the balance. Click opens that chat,
  right-click (or Shift+F10) copies the session id. Hover shows the title,
  token split, and that the figure is an OpenCode estimate.
- **Work Status** — the card follows the chat, not the panel's range.

Venice buckets usage by UTC date, so day labels in the panel are UTC and the
card's totals are UTC days.

## Configuration

The service reads the key; the sandboxed panel never sees it.

1. `VENICE_API_KEY` from the environment, if set.
2. Otherwise `mcp.servers.venice.environment.VENICE_API_KEY` in
   `$XDG_CONFIG_HOME/opencode/opencode.json` (default `~/.config/opencode`).

A missing key shows `no-key`; an inference-only key shows a 403 banner.

## How it works

- Billing comes from Venice: `/v1/billing/balance`,
  `/v1/billing/usage-analytics`, `/v1/billing/usage-history`,
  `/v1/api_keys/rate_limits`.
- Per-chat figures come from `~/.local/share/opencode/opencode.db`, filtered to
  messages whose provider is `venice`. Venice has no session id, so those
  figures are OpenCode estimates, not billed amounts.
- Daily token counts are derived from ledger `units` on `*-mtoken` SKUs, which
  are millions of tokens.
- Analytics is cached in-process for 60 seconds; Venice itself caches for 10
  minutes.

## Development

```bash
npm install
npm run build       # panel IIFE + service CJS
npm run typecheck

# run the service alone
OPENCHAMBER_SERVICE_PORT=3999 OPENCHAMBER_SERVICE_TOKEN=dev node service/main.js
curl -s -H 'Authorization: Bearer dev' http://127.0.0.1:3999/balance
```

Layout:

```
panel/     iframe UI (connectHost, host.serviceRequest)
service/   loopback HTTP service: billing, ledger, sessions, status
build.mjs  esbuild: IIFE for the panel, CJS for the service
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `403` banner | key can call models but not billing |
| `no-key` | key not in env or `opencode.json` |
| Numbers look stale | Venice caches analytics for 10 minutes |
| Rail icon unchanged | manifest edits need an extension reload |
| Session click does nothing | `sessions` capability not granted |

## Limitations

- Venice bills at account level; per-chat figures are estimates.
- No full-screen page or slash commands.
- Rate-limit hits cover the last 50 log entries only.
- Per-message cost is not implemented: OpenCode messages carry no id that
  matches a Venice ledger request.

## License

MIT
