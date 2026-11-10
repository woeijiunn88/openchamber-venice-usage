# openchamber-venice-usage

OpenChamber extension: Venice account balance, spend, tokens and billing ledger
in the right rail, plus a Work Status card.

## What it shows

- **Header** — refresh stamp, balance, the current chat cost, and today /
  yesterday / 7-day / 30-day totals.
- **Usage** — spend for the selected range, peak day, average per day, 30-day
  run-rate, a daily table with tokens in/out/cache, spend by type, top models,
  and efficiency cells (cache hit, cost per 1M tokens, cost per request).
- **Models** — per-model share, units and token split, then the same range by
  API key.
- **Sessions** — Venice spend per chat from OpenCode's database. Click opens the
  chat, right-click copies the id. Labelled as an OpenCode estimate.
- **Ledger** — the newest charges with their SKU and the largest on the page.
- **Limits** — tier, access, model count, rate-limit hits, next epoch and a
  sample of RPM/TPM.

Range is a select: last 7, 30 or 90 days. Day labels are UTC. Hovering a derived
figure explains its formula.

## Work Status

`contributes.statusSection.source` points the host at `GET /status`, so the card
is drawn by OpenChamber with no iframe. Rows: Balance (badge only when the key
cannot spend), Today, Yesterday, 7 days. The chat figure lives under the balance
in the panel: click opens the chat, right-click copies the session id.

## API key

Read by the service, never exposed to the panel:

1. `VENICE_API_KEY`, if set.
2. `mcp.servers.venice.environment.VENICE_API_KEY` in
   `$XDG_CONFIG_HOME/opencode/opencode.json`.

Billing endpoints need an **admin** key; an inference key gets a 403 banner.

## Requirements

- OpenChamber 2.0.1 or newer.
- Node 22+ only to build; the built files run inside OpenChamber.

## Install

1. `npm install && npm run build` (only needed after editing sources).
2. Settings → Extensions → paste this folder's path or the repository URL.
3. Approve the local **service** capability.

## Data

- Venice billing: `/v1/billing/balance`, `/billing/usage-analytics`,
  `/billing/usage-history`, `/api_keys/rate_limits`.
- `~/.local/share/opencode/opencode.db` for per-chat estimates.
- Accumulated tokens are derived from ledger `units` on `*-mtoken` SKUs.

## Not included

Full-screen page and slash commands. Venice bills at account level, so per-chat
figures are OpenCode's estimate, not billed amounts.
