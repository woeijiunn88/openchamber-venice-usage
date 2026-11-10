/**
 * Venice usage — panel (sandboxed iframe).
 *
 * Layout: native OpenChamber kit. Pane tabs and the range switch are
 * `mountTabs`, lists are `mountList`, status and failure text use badges and
 * banners. Only the KPI cells, the daily rows and the key/value rows are drawn
 * here, because the kit has no table or card component.
 */
import { connectHost, type HostClient } from '@openchamber/sdk';
import { applyHostReady, mountBanner, mountList, mountSelect, mountTabs } from '@openchamber/sdk/ui';

const REFRESH_MS = 60_000;
const PANES = ['usage', 'models', 'ledger', 'limits'] as const;
type Pane = (typeof PANES)[number];
const RANGES = [7, 30, 90] as const;

// ---------------------------------------------------------------- types

interface BalanceView {
  ok: true;
  usd: number;
  diem: number;
  bundledCredits: number;
  canConsume: boolean;
  currency: string;
  fetchedAt: number;
  key: { source: string | null; present: boolean };
}

interface ModelView {
  name: string;
  type: string;
  unitType: string;
  units: number;
  usd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface SummaryView {
  ok: true;
  days: number;
  totalUsd: number;
  todayUsd: number;
  last7Usd: number;
  byDate: { date: string; usd: number; input: number; output: number; cache: number; charges: number; requests: number }[];
  byModel: ModelView[];
  byKey: { id: string; name: string; usd: number; units: number }[];
  fetchedAt: number;
}

interface LedgerRow {
  ts: string;
  amount: number;
  sku: string;
  notes: string;
  currency: string;
  units: number;
  unitPrice: number;
  requestId: string | null;
}

interface LedgerView {
  ok: true;
  rows: LedgerRow[];
  scanned: number;
  fetchedAt: number;
}

interface SessionUsageView {
  ok: true;
  id: string;
  messages: number;
  cost: number;
  model: string | null;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  lastAt: number;
}

interface KeyView {
  ok: true;
  permitted: boolean;
  tier: string | null;
  charged: boolean;
  expiresAt: string | null;
  nextEpochAt: string | null;
  modelCount: number;
  exceeded?: number;
  limits: { model: string; limits: string[] }[];
}

class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------- preview


// ---------------------------------------------------------------- dom

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const app = document.getElementById('app');
if (!app) throw new Error('missing #app');

const panel = h('div', 'panel');
const head = h('div', 'head');
const title = h('span', 'title', 'Venice Usage');
const headSpacer = h('span', 'spacer');
const stamp = h('span', 'stamp', '');
const refreshHost = h('span', 'refresh-host');
head.append(title, headSpacer, stamp, refreshHost);

const balanceRow = h('div', 'balance-row');
const balanceValue = h('span', 'big', '—');
const balanceCaption = h('span', 'caption', 'balance USD');
balanceRow.append(balanceValue, balanceCaption);

const chatRow = h('div', 'chat-row');
const chatK = h('span', 'chat-k', 'Chat');
const chatCost = h('span', 'chat-cost', '');
const chatNote = h('span', 'chat-note', '');
chatRow.append(chatK, chatCost, chatNote);
chatRow.hidden = true;
chatRow.tabIndex = 0;
chatRow.setAttribute('role', 'button');
chatRow.setAttribute('aria-label', 'Current chat Venice usage. Enter opens the chat, Shift+F10 copies the session id.');

const statsRow = h('div', 'stats');
const statToday = h('span', 'stat');
const statTodayV = h('span', 'stat-v', '—');
statToday.append(h('span', 'stat-k', 'Today'), statTodayV);
const statYesterday = h('span', 'stat');
const statYesterdayV = h('span', 'stat-v', '—');
statYesterday.append(h('span', 'stat-k', 'Yest'), statYesterdayV);
const stat7 = h('span', 'stat');
const stat7V = h('span', 'stat-v', '—');
stat7.append(h('span', 'stat-k', '7d'), stat7V);
const stat30 = h('span', 'stat');
const stat30V = h('span', 'stat-v', '—');
stat30.append(h('span', 'stat-k', '30d'), stat30V);
statsRow.append(statToday, statYesterday, stat7, stat30);

const bannerHost = h('div', 'banner-host');
bannerHost.hidden = true;

const paneTabs = h('div', 'pane-tabs');
const toolbar = h('div', 'toolbar');
const toolbarLabel = h('span', 'toolbar-k', 'Range');
const rangeHost = h('span', 'range-host');
toolbar.append(toolbarLabel, rangeHost);
const paneBody = h('div', 'pane-body');

const foot = h('div', 'foot');
const footLeft = h('span', undefined, 'UTC days · Venice caches usage 10 min');
const footRight = h('span', undefined, '');
foot.append(footLeft, footRight);

panel.append(head, balanceRow, chatRow, statsRow, bannerHost, paneTabs, toolbar, paneBody, foot);
app.append(panel);

/** Remixicon `loop-right`, the host's own refresh glyph. */
const REFRESH_PATH =
  'M12 4C14.7486 4 17.1749 5.38626 18.6156 7.5H16V9.5H22V3.5H20V5.99936C18.1762 3.57166 15.2724 2 12 2C6.47715 2 2 6.47715 2 12H4C4 7.58172 7.58172 4 12 4ZM20 12C20 16.4183 16.4183 20 12 20C9.25144 20 6.82508 18.6137 5.38443 16.5H8V14.5H2V20.5H4V18.0006C5.82381 20.4283 8.72764 22 12 22C17.5228 22 22 17.5228 22 12H20Z';

const refreshButton = h('button', 'icon-btn');
refreshButton.type = 'button';
refreshButton.title = 'Refresh';
refreshButton.setAttribute('aria-label', 'Refresh');
refreshButton.innerHTML =
  `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="${REFRESH_PATH}" fill="currentColor" /></svg>`;
refreshButton.addEventListener('click', () => void refresh());
refreshHost.append(refreshButton);
const banner = mountBanner(bannerHost, { tone: 'error', title: '' });

const paneTabsHandle = mountTabs(paneTabs, {
  items: [
    { id: 'usage', label: 'Usage' },
    { id: 'models', label: 'Models' },
    { id: 'ledger', label: 'Ledger' },
    { id: 'limits', label: 'Limits' },
  ],
  activeId: 'usage',
  onChange: (id) => {
    pane = id as Pane;
    paneTabsHandle.update({ activeId: pane });
    render();
    if (pane === 'ledger') void loadLedger();
    if (pane === 'limits' && !key) void loadKey();
  },
});

const rangeSelect = mountSelect(rangeHost, {
  value: '30',
  options: [
    { id: '7', label: 'Last 7 days' },
    { id: '30', label: 'Last 30 days' },
    { id: '90', label: 'Last 90 days' },
  ],
  onChange: (id) => {
    range = Number(id);
    rangeSelect.update({ value: id });
    void loadSummary().then(() => render());
  },
});

// ---------------------------------------------------------------- state

let pane: Pane = 'usage';
let range = 7;
let balance: BalanceView | null = null;
let summary: SummaryView | null = null;
let month: SummaryView | null = null;
let ledger: LedgerView | null = null;
let key: KeyView | null = null;
let sessionUsage: SessionUsageView | null = null;
let sessionFailed = false;
let session: { id: string; title: string } | null = null;
let loading = false;

// ---------------------------------------------------------------- service

let host: HostClient | null = null;

function hostClient(): HostClient {
  if (!host) host = connectHost();
  return host;
}

async function request<T>(path: string, query?: Record<string, string>): Promise<T> {
  const res = await hostClient().serviceRequest({ method: 'GET', path, query });
  let body: unknown;
  try {
    body = JSON.parse(res.body || '{}');
  } catch {
    throw new ServiceError(res.status, 'bad-json', 'Service returned unreadable JSON.');
  }
  const record = body as { ok?: boolean; error?: string; message?: string };
  if (res.status !== 200 || record?.ok === false) {
    throw new ServiceError(res.status, record?.error ?? 'request-failed', record?.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

async function loadBalance(): Promise<void> {
  balance = await request<BalanceView>('/balance');
}

async function loadSummary(): Promise<void> {
  summary = await request<SummaryView>('/summary', { days: String(range) });
  if (range === 30) month = summary;
}

/** Fixed 30-day snapshot for the glance header, whatever range the pane uses. */
async function loadMonth(): Promise<void> {
  if (range === 30 && summary) {
    month = summary;
    return;
  }
  month = await request<SummaryView>('/summary', { days: '30' });
}

async function loadLedger(): Promise<void> {
  ledger = await request<LedgerView>('/ledger', { limit: '100', days: '30' });
  render();
}

async function loadSession(): Promise<void> {
  if (!session) {
    sessionUsage = null;
    return;
  }
  sessionUsage = await request<SessionUsageView>('/session', { id: session.id });
}

async function loadKey(): Promise<void> {
  key = await request<KeyView>('/key');
  render();
}

async function refresh(): Promise<void> {
  if (loading) return;
  loading = true;
  refreshButton.disabled = true;
  try {
    await loadBalance();
    await loadSummary();
    await loadMonth();
    await loadKey();
    await loadSession()
      .then(() => {
        sessionFailed = false;
      })
      .catch(() => {
        sessionUsage = null;
        sessionFailed = true;
      });
    if (pane === 'ledger') await loadLedger();
    showBanner(null);
    render();
  } catch (error) {
    report(error);
  } finally {
    loading = false;
    refreshButton.disabled = false;
  }
}

function report(error: unknown): void {
  const err = error instanceof ServiceError ? error : new ServiceError(0, 'internal', String(error));
  if (err.code === 'no-key') {
    showBanner('No Venice API key found. Add one to the Venice MCP entry in opencode.json, or set VENICE_API_KEY.');
  } else if (err.code === 'forbidden') {
    showBanner('Venice refused the key. Usage endpoints need an admin key; inference keys cannot read billing.');
  } else {
    showBanner(err.message || 'Could not load Venice usage.');
  }
  stamp.textContent = 'error';
}

function showBanner(message: string | null): void {
  if (!message) {
    bannerHost.hidden = true;
    return;
  }
  bannerHost.hidden = false;
  banner.update({ tone: 'error', title: 'Venice usage unavailable', body: message });
}

// ---------------------------------------------------------------- format

function fmtUsd(value: number): string {
  const abs = Math.abs(value);
  if (!Number.isFinite(value)) return '$0';
  if (abs >= 1000) return `$${value.toFixed(0)}`;
  if (abs >= 100) return `$${value.toFixed(1)}`;
  if (abs >= 1) return `$${value.toFixed(2)}`;
  if (abs >= 0.01) return `$${value.toFixed(4)}`;
  if (abs === 0) return '$0';
  return `$${value.toFixed(5)}`;
}

function fmtSmall(value: number): string {
  if (value === 0) return '0';
  return Math.abs(value) >= 0.01 ? value.toFixed(4) : value.toFixed(5);
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClock(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtLimit(text: string): string {
  return text.replace(/(\d{7,})/g, (raw) => {
    const n = Number(raw);
    if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1))}M`;
    return `${Number((n / 1000).toFixed(0))}k`;
  });
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtPrice(n: number): string {
  if (n >= 1) return `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
  const trimmed = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `$${trimmed}`;
}

function fmtCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ---------------------------------------------------------------- pieces

function kpiRow(cells: { label: string; value: string; sub?: string; hint?: string }[]): HTMLElement {
  const row = h('div', 'kpis');
  for (const cell of cells) {
    const box = h('div', 'kpi');
    box.append(h('div', 'k', cell.label), h('div', 'v', cell.value));
    if (cell.sub) box.append(h('div', 'sub', cell.sub));
    if (cell.hint) box.title = cell.hint;
    row.append(box);
  }
  return row;
}

function kvRow(label: string, value: string, hint?: string): HTMLElement {
  const row = h('div', 'kv');
  row.append(h('span', 'kv-k', label), h('span', 'kv-v', value));
  if (hint) row.title = hint;
  return row;
}

// ---------------------------------------------------------------- render

function renderChatRow(): void {
  if (!session) {
    chatRow.hidden = true;
chatRow.tabIndex = 0;
chatRow.setAttribute('role', 'button');
chatRow.setAttribute('aria-label', 'Current chat Venice usage. Enter opens the chat, Shift+F10 copies the session id.');
    return;
  }
  chatRow.hidden = false;

  const usage = sessionUsage && sessionUsage.id === session.id ? sessionUsage : null;
  const empty = usage !== null && usage.messages === 0;
  const failed = !usage && sessionFailed;

  chatCost.hidden = empty || failed;
  chatNote.hidden = !(empty || failed);
  chatNote.textContent = empty ? 'no Venice usage' : failed ? 'chat data unavailable' : '';
  chatCost.textContent = usage ? (empty ? '' : fmtUsd(usage.cost)) : failed ? '' : '…';

  if (failed) {
    chatRow.title = `${session.title || session.id}\n${session.id}\nCould not read this chat from opencode.db. OpenCode accounting is unavailable; the billing figures above still apply.`;
    return;
  }
  if (!usage) {
    chatRow.title = `${session.title || session.id}\n${session.id}`;
    return;
  }
  if (empty) {
    chatRow.title = `${session.title || session.id}\n${session.id}\nno Venice usage in this chat yet`;
    return;
  }
  const parts: string[] = [];
  if (usage.tokens.input > 0) parts.push(`in ${fmtTokens(usage.tokens.input)}`);
  if (usage.tokens.output + usage.tokens.reasoning > 0) {
    parts.push(`out ${fmtTokens(usage.tokens.output + usage.tokens.reasoning)}`);
  }
  if (usage.tokens.cacheRead > 0) parts.push(`cache ${fmtTokens(usage.tokens.cacheRead)}`);
  const detail = usage.messages === 0 ? 'no billed calls' : parts.join(' · ');
  chatRow.title = `${session.title || session.id}\n${session.id}\n${detail}\nOpenCode accounting · right-click copies the session id`;
}

chatRow.addEventListener('click', () => {
  if (session) void hostClient().openSession(session.id);
});
chatRow.addEventListener('keydown', (event) => {
  if (!session) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    void hostClient().openSession(session.id);
    return;
  }
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    copySessionId(session.id);
  }
});
chatRow.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (session) copySessionId(session.id);
});

function renderBalance(): void {
  balanceValue.textContent = balance ? fmtUsd(balance.usd) : '—';
  balanceValue.title = balance
    ? `Prepaid USD credit on this key. ${balance.canConsume ? 'Spendable now.' : 'Spending is blocked.'} Venice caches the figure for up to 10 minutes.`
    : 'Loading the balance from Venice.';
  balanceCaption.textContent = balance ? (balance.canConsume ? 'USD · can spend' : 'USD · blocked') : 'USD';
  if (balance) footRight.textContent = balance.key.source === 'env' ? 'key: env' : 'key: opencode.json';
  stamp.textContent = summary ? `updated ${fmtClock(summary.fetchedAt)}` : '';
  stamp.title = summary ? new Date(summary.fetchedAt).toLocaleString() : '';

  if (!month) return;
  const days = month.byDate;
  const today = month.todayUsd;
  const yesterday = days.length > 1 ? days[days.length - 2].usd : 0;
  statTodayV.textContent = fmtUsd(today);
  statYesterdayV.textContent = fmtUsd(yesterday);
  statTodayV.title = `yesterday ${fmtUsd(yesterday)}`;
  const last7 = days.slice(-7).reduce((sum, d) => sum + d.usd, 0);
  const last30 = days.slice(-30).reduce((sum, d) => sum + d.usd, 0);
  stat7V.textContent = fmtUsd(last7);
  stat30V.textContent = fmtUsd(last30);
}

function copySessionId(id: string): void {
  void hostClient()
    .writeClipboard(id)
    .then(() => hostClient().toast({ kind: 'success', message: 'Session id copied', dismiss: true }))
    .catch(() => {});
}

const TYPE_LABEL: Record<string, string> = {
  LLM: 'Text',
  IMAGE: 'Image',
  VIDEO: 'Video',
  TTS: 'Speech',
  MUSIC: 'Music',
};

function renderUsage(): void {
  paneBody.textContent = '';
  if (!summary) {
    paneBody.append(h('div', 'loading', 'Loading usage…'));
    return;
  }
  const days = summary.days;
  const total = summary.totalUsd;
  const avg = total / days;
  const peak = summary.byDate.reduce((best, d) => (d.usd > best.usd ? d : best), { date: '', usd: 0 });
  const active = summary.byDate.filter((d) => d.usd > 0).length;

  paneBody.append(
    kpiRow([
      {
        label: `SPENT · ${days}D`,
        value: fmtUsd(total),
        sub: peak.usd > 0 ? `peak ${peak.date.slice(5)} · ${fmtUsd(peak.usd)}` : 'no spend yet',
        hint: `Venice billing for the last ${days} UTC days. Peak day: ${peak.usd > 0 ? `${peak.date} at ${fmtUsd(peak.usd)}` : 'none'}. Figures are cached by Venice for up to 10 minutes.`,
      },
      {
        label: 'AVG / DAY',
        value: fmtUsd(avg),
        sub: `${active} active ${active === 1 ? 'day' : 'days'}`,
        hint: `${fmtUsd(total)} ÷ ${days} days. Zero-spend days are included, so this is the true daily average, not the average of active days.`,
      },
      {
        label: 'RUN-RATE · 30D',
        value: fmtUsd(avg * 30),
        sub: 'not a forecast',
        hint: `Average per day × 30. A straight extrapolation of the selected range; it assumes usage stays flat.`,
      },
    ]),
  );

  const daily = h('div', 'card daily');
  const dailyLabel = h('div', 'card-k', days > 7 ? `Daily · ${days} days · scroll` : `Daily · ${days} days`);
  dailyLabel.title =
    'One UTC day per row, from the billing ledger. Tokens are billed input (not cache reads), completion tokens, and cache reads; media days show a charge count instead.';
  daily.append(dailyLabel);
  const dates = summary.byDate;
  const rows = dates.slice(-days).reverse();
  const dayList = h('div', 'day-list');
  for (const [index, day] of rows.entries()) {
    const label = index === 0 ? 'Today' : index === 1 ? 'Yesterday' : day.date.slice(5);
    const parts: string[] = [];
    if (day.input > 0) parts.push(`in ${fmtTokens(day.input)}`);
    if (day.output > 0) parts.push(`out ${fmtTokens(day.output)}`);
    if (day.cache > 0) parts.push(`cache ${fmtTokens(day.cache)}`);
    const detail = parts.length > 0
      ? parts.join(' · ')
      : day.charges > 0
        ? `${day.charges} ${day.charges === 1 ? 'charge' : 'charges'}`
        : 'no billed calls';

    const row = h('div', 'day-row');
    row.title = `${day.date} · ${detail} · ${fmtUsd(day.usd)}`;
    row.append(h('span', 'day-date', label), h('span', 'day-tok', detail), h('span', 'day-amt', fmtUsd(day.usd)));
    dayList.append(row);
  }
  daily.append(dayList);

  paneBody.append(daily);

  const totals = summary.byDate.reduce(
    (acc, day) => ({
      input: acc.input + day.input,
      output: acc.output + day.output,
      cache: acc.cache + day.cache,
      requests: acc.requests + day.requests,
    }),
    { input: 0, output: 0, cache: 0, requests: 0 },
  );
  const llmModels = summary.byModel.filter((m) => m.type === 'LLM');
  const llmUsd = llmModels.reduce((sum, m) => sum + m.usd, 0);
  const llmUnits = llmModels.reduce((sum, m) => sum + m.units, 0);
  const promptTokens = totals.input + totals.cache;
  const cacheRate = promptTokens > 0 ? (totals.cache / promptTokens) * 100 : null;
  const perMillion = llmUnits > 0 ? llmUsd / llmUnits : null;
  const perRequest = totals.requests > 0 ? summary.totalUsd / totals.requests : null;

  paneBody.append(
    kpiRow([
      {
        label: 'CACHE HIT',
        value: cacheRate === null ? '—' : `${Math.round(cacheRate)}%`,
        sub: 'of prompt tokens',
        hint: `Cache-read tokens ÷ (input + cache-read) = ${fmtTokens(totals.cache)} ÷ (${fmtTokens(totals.input)} + ${fmtTokens(totals.cache)}). Output tokens are excluded. Venice reports cache reads only, so writes cannot be shown.`,
      },
      {
        label: '$ / 1M TOKENS',
        value: perMillion === null ? '—' : fmtUsd(perMillion),
        sub: 'text models',
        hint: `Text-model spend ${fmtUsd(llmUsd)} ÷ ${llmUnits.toFixed(2)}M text tokens (input + output + cache). Image and video spend is excluded because it is billed per image or second.`,
      },
      {
        label: '$ / REQUEST',
        value: perRequest === null ? '—' : fmtUsd(perRequest),
        sub: totals.requests > 0 ? `${fmtCount(totals.requests)} requests` : 'no request ids',
        hint: `${fmtUsd(summary.totalUsd)} ÷ ${fmtCount(totals.requests)} distinct request ids in the billing ledger. One request can produce several charge rows (input, output, cache), and video or image calls are included.`,
      },
    ]),
  );

  const groups = new Map<string, number>();
  for (const model of summary.byModel) {
    const label = TYPE_LABEL[model.type] ?? (model.type || 'Other');
    groups.set(label, (groups.get(label) ?? 0) + model.usd);
  }
  const ordered = [...groups.entries()].filter(([, usd]) => usd > 0).sort((a, b) => b[1] - a[1]);
  if (ordered.length > 0) {
    const card = h('div', 'card');
    card.append(h('div', 'card-k', 'Spend by type'));
    const stack = h('div', 'stack');
    const legend = h('div', 'legend');
    const base = ordered.reduce((sum, [, usd]) => sum + usd, 0) || 1;
    ordered.forEach(([label, usd], index) => {
      const share = usd / base;
      const seg = h('i');
      seg.style.width = `${(share * 100).toFixed(2)}%`;
      seg.style.opacity = String([0.85, 0.55, 0.32, 0.18][index] ?? 0.12);
      seg.title = `${label} · ${fmtUsd(usd)}`;
      stack.append(seg);

      const row = h('div', 'legend-row');
      const dot = h('span', 'legend-dot');
      dot.style.opacity = String([0.85, 0.55, 0.32, 0.18][index] ?? 0.12);
      row.append(dot, h('span', 'legend-name', label), h('span', 'legend-meta', `${Math.round(share * 100)}% · ${fmtUsd(usd)}`));
      row.title = `${label}: ${fmtUsd(usd)} of ${fmtUsd(base)} in this range (${Math.round(share * 100)}%). ${
        label === 'Text' ? 'Billed per token.' : 'Billed per image or second, so no token figure applies.'
      }`;
      legend.append(row);
    });
    card.append(stack, legend);
    paneBody.append(card);
  }

  const top = summary.byModel.slice(0, 3);
  if (top.length > 0) {
    const totalModels = summary.byModel.reduce((sum, m) => sum + m.usd, 0) || 1;
    const listHost = h('div', 'list-host');
    paneBody.append(h('div', 'card-k', 'Top models'), listHost);
    mountList(listHost, {
      ariaLabel: 'Top models',
      selectedId: null,
      onSelect: () => {},
      items: top.map((m) => ({
        id: m.name,
        title: m.name,
        subtitle: `${TYPE_LABEL[m.type] ?? m.type} · ${Math.round((m.usd / totalModels) * 100)}% of spend`,
        meta: fmtUsd(m.usd),
      })),
    });
    const topRows = listHost.querySelectorAll<HTMLElement>('.oc-sdk-row');
    top.forEach((model, index) => {
      const row = topRows[index];
      if (!row) return;
      const share = totalModels > 0 ? Math.round((model.usd / totalModels) * 100) : 0;
      const detail =
        model.type === 'LLM'
          ? `in ${fmtSmall(model.input)} · out ${fmtSmall(model.output)}${model.cacheRead ? ` · cache ${fmtSmall(model.cacheRead)}` : ''}`
          : `${model.units} ${model.units === 1 ? model.unitType.replace(/s$/, '') : model.unitType}`;
      row.title = `${model.name}\n${fmtUsd(model.usd)} · ${share}% of range spend\n${detail}`;
    });
  }

}

function renderModels(): void {
  paneBody.textContent = '';
  if (!summary) {
    paneBody.append(h('div', 'loading', 'Loading models…'));
    return;
  }
  const listHost = h('div', 'list-host');
  paneBody.append(h('div', 'card-k', `Models · ${summary.days} days`), listHost);
  const modelRows = summary.byModel;
  mountList(listHost, {
    ariaLabel: 'Spend by model',
    selectedId: null,
    onSelect: () => {},
    emptyText: 'No billable calls in this range.',
    items: summary.byModel.map((m) => {
      const unit = m.units === 1 ? m.unitType.replace(/s$/, '') : m.unitType;
      const detail = m.type === 'LLM'
        ? `in ${fmtSmall(m.input)} · out ${fmtSmall(m.output)}${m.cacheRead ? ` · cache ${fmtSmall(m.cacheRead)}` : ''}`
        : `${m.units} ${unit}`;
      const share = summary!.totalUsd > 0 ? Math.round((m.usd / summary!.totalUsd) * 100) : 0;
      return {
        id: m.name,
        title: m.name,
        subtitle: `${TYPE_LABEL[m.type] ?? m.type} · ${share}% · ${detail}`,
        meta: fmtUsd(m.usd),
      };
    }),
  });
  const mounted = listHost.querySelectorAll<HTMLElement>('.oc-sdk-row');
  modelRows.forEach((model, index) => {
    const row = mounted[index];
    if (!row) return;
    const units = model.type === 'LLM'
      ? `${model.units.toFixed(2)}M tokens`
      : `${model.units} ${model.units === 1 ? model.unitType.replace(/s$/, '') : model.unitType}`;
    row.title = `${model.name}\n${fmtUsd(model.usd)} · ${units}\n` +
      (model.type === 'LLM'
        ? `input ${fmtUsd(model.input)} · output ${fmtUsd(model.output)} · cache read ${fmtUsd(model.cacheRead)}`
        : 'Billed per image or second; no token split.');
  });

  if (summary.byKey.length > 0) {
    const keyHost = h('div', 'list-host');
    paneBody.append(h('div', 'card-k', 'By key'), keyHost);
    const total = summary.byKey.reduce((sum, k) => sum + k.usd, 0) || 1;
    mountList(keyHost, {
      ariaLabel: 'Spend by API key',
      selectedId: null,
      onSelect: () => {},
      items: summary.byKey.map((k) => ({
        id: k.id || k.name,
        title: k.name,
        subtitle: `${Math.round((k.usd / total) * 100)}% of spend`,
        meta: fmtUsd(k.usd),
      })),
    });
  }
}

function renderLedger(): void {
  paneBody.textContent = '';
  if (!ledger) {
    paneBody.append(h('div', 'loading', 'Loading ledger…'));
    return;
  }
  const listHost = h('div', 'list-host');
  paneBody.append(h('div', 'card-k', 'Charges · 30 days'), listHost);
  mountList(listHost, {
    ariaLabel: 'Recent charges',
    selectedId: null,
    onSelect: () => {},
    emptyText: 'No charges in the last 30 days.',
    items: ledger.rows.map((row) => ({
      id: `${row.ts}-${row.sku}-${row.amount}`,
      title: row.notes || row.sku,
      subtitle: `${fmtWhen(row.ts)} · ${row.sku}`,
      meta: `${row.amount < 0 ? '−' : '+'}${fmtUsd(Math.abs(row.amount))}`,
    })),
  });

  const ledgerRows = listHost.querySelectorAll<HTMLElement>('.oc-sdk-row');
  ledger.rows.forEach((row, index) => {
    const el = ledgerRows[index];
    if (!el) return;
    const isTokenRate = row.sku.endsWith('-mtoken');
    const quantity = isTokenRate
      ? `${Math.round(row.units * 1_000_000).toLocaleString('en-US')} tokens @ ${fmtPrice(row.unitPrice)} / 1M`
      : `${row.units} ${row.units === 1 ? 'unit' : 'units'} @ ${fmtPrice(row.unitPrice)} each`;
    el.title =
      `${row.notes || row.sku}\n${row.sku}\n` +
      `${new Date(row.ts).toLocaleString()} · ${quantity} = ${fmtUsd(Math.abs(row.amount))}\n` +
      (row.requestId ? `request ${row.requestId}` : 'no request id on this row');
  });
  const biggest = ledger.rows.reduce((best, row) => (Math.abs(row.amount) > Math.abs(best.amount) ? row : best), ledger.rows[0]);
  if (biggest) {
    paneBody.append(h('div', 'note', `Largest on this page: ${biggest.notes || biggest.sku} ${fmtUsd(Math.abs(biggest.amount))} · ${fmtWhen(biggest.ts)}`));
  }
  if (ledger.scanned > ledger.rows.length) {
    paneBody.append(h('div', 'note', `Showing newest ${ledger.rows.length} of ${fmtCount(ledger.scanned)} scanned charges.`));
  }
}

function renderLimits(): void {
  paneBody.textContent = '';
  if (!key) {
    paneBody.append(h('div', 'loading', 'Loading limits…'));
    return;
  }
  const keyBlock = h('div', 'kv-block');
  keyBlock.append(h('div', 'card-k', 'Key'));
  keyBlock.append(
    kvRow(
      'Tier',
      key.tier ?? 'unknown',
      'Plan attached to this API key. It sets rate limits and any bundled credits; it does not change the per-call price.',
    ),
    kvRow(
      'Access',
      key.permitted ? 'permitted' : 'refused',
      'Whether Venice currently accepts this key for inference.',
    ),
  );
  if (key.expiresAt) keyBlock.append(kvRow('Expires', fmtWhen(key.expiresAt)));
  if (key.nextEpochAt) keyBlock.append(kvRow('Next epoch', fmtWhen(key.nextEpochAt), 'When the current billing epoch rolls over; local time.'));
  paneBody.append(keyBlock);

  const usageBlock = h('div', 'kv-block');
  usageBlock.append(h('div', 'card-k', 'Account'));
  usageBlock.append(
    kvRow('Models', `${key.modelCount}`, 'Models listed in the live Venice catalog for this key.'),
    kvRow('Rate-limit hits', `${key.exceeded ?? 0}`, 'Rate-limit rejections recorded in the last 50 log entries (experimental endpoint).'),
  );
  paneBody.append(usageBlock);

  const listHost = h('div', 'list-host');
  const limitsLabel = h('div', 'card-k', 'Sample limits');
  limitsLabel.title = 'Per-model RPM and TPM limits reported for this key by /v1/api_keys/rate_limits.';
  paneBody.append(limitsLabel, listHost);
  mountList(listHost, {
    ariaLabel: 'Rate limits',
    selectedId: null,
    onSelect: () => {},
    emptyText: 'No rate limits reported.',
    items: key.limits.map((l) => ({
      id: l.model,
      title: l.model,
      meta: l.limits.map(fmtLimit).join(' · '),
    })),
  });

  const limitRows = listHost.querySelectorAll<HTMLElement>('.oc-sdk-row');
  key.limits.forEach((limit, index) => {
    const el = limitRows[index];
    if (!el) return;
    el.title = `${limit.model}\n${limit.limits.map(fmtLimit).join(' · ')}\nRequests and tokens per minute allowed for this model on this key.`;
  });
}

function render(): void {
  renderBalance();
  renderChatRow();
  toolbar.hidden = pane === 'limits';
  if (pane === 'usage') renderUsage();
  else if (pane === 'models') renderModels();
  else if (pane === 'ledger') renderLedger();
  else renderLimits();
}

// ---------------------------------------------------------------- boot

function boot(): void {
  hostClient().onReady((context) => {
    applyHostReady(context, document.documentElement);
    if (context.session) session = { id: context.session.id, title: context.session.title };
    void refresh();
    hostClient().onSession((snapshot) => {
      session = snapshot ? { id: snapshot.id, title: snapshot.title } : null;
      void loadSession()
        .catch(() => {
          sessionUsage = null;
        })
        .then(() => render());
    });
    window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, REFRESH_MS);
  });
}

boot();
