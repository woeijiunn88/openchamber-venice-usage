/**
 * Venice usage extension — local service.
 *
 * Owns three things the sandboxed panel cannot do:
 *  1. Read the Venice API key from the local OpenCode config.
 *  2. Call the Venice billing endpoints (balance, analytics, ledger).
 *  3. Reshape the upstream payloads into the small JSON the panel renders.
 *
 * Started by the OpenChamber host as an Electron-as-Node child process. The
 * port and the bearer token arrive in OPENCHAMBER_SERVICE_PORT and
 * OPENCHAMBER_SERVICE_TOKEN.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT || 0);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN || '';

const API_BASE = 'https://api.venice.ai/api/v1';
const UPSTREAM_TIMEOUT_MS = 20_000;
/** Upstream analytics is cached for 10 minutes; a 60 s local cache is enough. */
const SUMMARY_TTL_MS = 60_000;
const LEDGER_PAGE_SIZE = 1000;
const LEDGER_MAX_PAGES = 5;

// ---------------------------------------------------------------- errors

class MissingKeyError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`No Venice API key found. Looked for VENICE_API_KEY and ${path}`);
    this.name = 'MissingKeyError';
    this.path = path;
  }
}

class UpstreamError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

// ---------------------------------------------------------------- key

interface KeyInfo {
  key: string;
  source: 'env' | 'opencode.json';
  path: string | null;
}

let keyCache: KeyInfo | null = null;

function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? xdg : join(homedir(), '.config');
}

/** Strip // and /* *\/ comments so a JSONC config still parses. */
function stripComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

function parseConfig(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripComments(text));
  }
}

function readConfiguredKey(path: string): string | null {
  if (!existsSync(path)) return null;
  let doc: unknown;
  try {
    doc = parseConfig(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const root = doc as Record<string, unknown> | null;
  const mcp = root?.mcp as Record<string, unknown> | undefined;
  const servers = mcp?.servers as Record<string, unknown> | undefined;
  const venice = (servers?.venice ?? mcp?.venice) as Record<string, unknown> | undefined;
  const env = venice?.environment as Record<string, unknown> | undefined;
  const value = env?.VENICE_API_KEY ?? venice?.apiKey;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function resolveKey(): KeyInfo {
  if (keyCache) return keyCache;
  const fromEnv = process.env.VENICE_API_KEY?.trim();
  if (fromEnv) {
    keyCache = { key: fromEnv, source: 'env', path: null };
    return keyCache;
  }
  const candidates = [
    join(configHome(), 'opencode', 'opencode.json'),
    join(configHome(), 'opencode', 'opencode.jsonc'),
  ];
  for (const path of candidates) {
    const key = readConfiguredKey(path);
    if (key) {
      keyCache = { key, source: 'opencode.json', path };
      return keyCache;
    }
  }
  throw new MissingKeyError(candidates[0]);
}

function keySource(): { source: string | null; path: string | null; present: boolean } {
  try {
    const info = resolveKey();
    return { source: info.source, path: info.path, present: true };
  } catch {
    return { source: null, path: null, present: false };
  }
}

// ---------------------------------------------------------------- upstream

async function getJson(path: string): Promise<unknown> {
  const { key } = resolveKey();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed?.error) detail = parsed.error;
    } catch {
      /* keep raw text */
    }
    throw new UpstreamError(res.status, detail || `HTTP ${res.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError(502, 'Venice returned unparseable JSON');
  }
}

// ---------------------------------------------------------------- shapes

interface UpstreamBreakdown {
  type?: string;
  usd?: number;
  diem?: number;
  units?: number;
}

interface UpstreamModelRow {
  modelName?: string;
  unitType?: string;
  modelType?: string;
  totalUsd?: number;
  totalDiem?: number;
  totalUnits?: number;
  breakdown?: UpstreamBreakdown[];
}

interface UpstreamKeyRow {
  apiKeyId?: string;
  description?: string;
  totalUsd?: number;
  totalDiem?: number;
  totalUnits?: number;
}

interface UpstreamAnalytics {
  byDate?: { date?: string; USD?: number; DIEM?: number }[];
  byModel?: UpstreamModelRow[];
  byKey?: UpstreamKeyRow[];
}

interface UpstreamHistoryRow {
  sku?: string;
  notes?: string;
  units?: number;
  amount?: number;
  currency?: string;
  timestamp?: string;
  pricePerUnitUsd?: number;
  inferenceDetails?: { requestId?: string } | null;
}

interface UpstreamHistory {
  data?: UpstreamHistoryRow[];
  nextCursor?: string | null;
}

interface UpstreamBalance {
  canConsume?: boolean;
  consumptionCurrency?: string;
  balances?: { usd?: number; diem?: number | null; bundledCredits?: number | null; earnedCredits?: number | null };
}

interface UpstreamRateLimits {
  data?: {
    accessPermitted?: boolean;
    apiTier?: { id?: string; isCharged?: boolean };
    keyExpiration?: string | null;
    nextEpochBegins?: string | null;
    rateLimits?: { apiModelId?: string; rateLimits?: { amount?: number; type?: string }[] }[];
  };
}

export interface BalanceView {
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

interface DayView {
  date: string;
  usd: number;
  input: number;
  output: number;
  cache: number;
  charges: number;
  requests: number;
}

export interface SummaryView {
  ok: true;
  days: number;
  totalUsd: number;
  todayUsd: number;
  last7Usd: number;
  byDate: DayView[];
  byModel: ModelView[];
  byKey: { id: string; name: string; usd: number; units: number }[];
  fetchedAt: number;
  cachedAt: number;
}

export interface LedgerRow {
  ts: string;
  amount: number;
  sku: string;
  notes: string;
  currency: string;
  units: number;
  unitPrice: number;
  requestId: string | null;
}

// ---------------------------------------------------------------- helpers

function fmtUsd(value: number): string {
  const abs = Math.abs(value);
  if (!Number.isFinite(value)) return '$0';
  if (abs >= 1000) return `$${value.toFixed(0)}`;
  if (abs >= 100) return `$${value.toFixed(1)}`;
  if (abs >= 1) return `$${value.toFixed(2)}`;
  if (abs === 0) return '$0';
  if (abs >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(5)}`;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function breakdownUsd(row: UpstreamModelRow, label: string): number {
  const wanted = label.toLowerCase();
  let total = 0;
  for (const part of row.breakdown ?? []) {
    if ((part.type ?? '').toLowerCase() === wanted) total += num(part.usd);
  }
  return total;
}

function toModelViews(rows: UpstreamModelRow[]): ModelView[] {
  return rows
    .map((row) => ({
      name: row.modelName ?? 'unknown',
      type: row.modelType ?? '',
      unitType: row.unitType ?? '',
      units: num(row.totalUnits),
      usd: num(row.totalUsd),
      input: breakdownUsd(row, 'Input'),
      output: breakdownUsd(row, 'Output'),
      cacheRead: breakdownUsd(row, 'Cache Read'),
      cacheWrite: breakdownUsd(row, 'Cache Write'),
    }))
    .sort((a, b) => b.usd - a.usd);
}

function fillDays(byDate: { date: string; usd: number }[], days: number): { date: string; usd: number }[] {
  const byKey = new Map(byDate.map((d) => [d.date, d.usd]));
  const out: { date: string; usd: number }[] = [];
  const today = Date.now();
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = utcDate(today - i * 86_400_000);
    out.push({ date, usd: byKey.get(date) ?? 0 });
  }
  return out;
}

// ---------------------------------------------------------------- summary

const summaryCache = new Map<string, { at: number; data: SummaryView }>();

async function buildSummary(days: number, withTokens = true): Promise<SummaryView> {
  const cacheKey = `${days}:${withTokens ? 1 : 0}`;
  const cached = summaryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.data;

  const raw = (await getJson(`/billing/usage-analytics?lookback=${days}d`)) as UpstreamAnalytics;
  const rawDays = (raw.byDate ?? [])
    .filter((row) => typeof row.date === 'string' && row.date)
    .map((row) => ({ date: row.date as string, usd: num(row.USD) }));

  let totals = new Map<string, DayView>();
  if (withTokens) {
    try {
      totals = await loadDailyTotals(days);
    } catch {
      /* token detail is optional; keep the spend figures if the ledger fails */
    }
  }

  const byDate = fillDays(rawDays, days).map((day) => {
    const extra = totals.get(day.date);
    return {
      date: day.date,
      usd: day.usd,
      input: extra ? Math.round(extra.input) : 0,
      output: extra ? Math.round(extra.output) : 0,
      cache: extra ? Math.round(extra.cache) : 0,
      charges: extra ? extra.charges : 0,
      requests: extra ? extra.requests : 0,
    };
  });

  const perDay = new Map(rawDays.map((d) => [d.date, d.usd]));
  const todayKey = utcDate(Date.now());
  const todayUsd = perDay.get(todayKey) ?? 0;
  let last7Usd = 0;
  for (let i = 0; i < 7; i += 1) last7Usd += perDay.get(utcDate(Date.now() - i * 86_400_000)) ?? 0;
  const totalUsd = rawDays.reduce((sum, d) => sum + d.usd, 0);

  const byKey = (raw.byKey ?? []).map((row) => ({
    id: row.apiKeyId ?? '',
    name: row.description || 'unnamed key',
    usd: num(row.totalUsd),
    units: num(row.totalUnits),
  }));

  const data: SummaryView = {
    ok: true,
    days,
    totalUsd,
    todayUsd,
    last7Usd,
    byDate,
    byModel: toModelViews(raw.byModel ?? []),
    byKey,
    fetchedAt: Date.now(),
    cachedAt: cached?.at ?? 0,
  };
  summaryCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

// ---------------------------------------------------------------- ledger

async function scanHistory(days: number): Promise<UpstreamHistoryRow[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const filters = new URLSearchParams({
    pageSize: String(LEDGER_PAGE_SIZE),
    startTimestamp: start.toISOString(),
    endTimestamp: end.toISOString(),
  });

  const collected: UpstreamHistoryRow[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : `?${filters.toString()}`;
    const raw: UpstreamHistory = (await getJson(`/billing/usage-history${query}`)) as UpstreamHistory;
    collected.push(...(raw.data ?? []));
    cursor = raw.nextCursor ?? null;
    pages += 1;
  } while (cursor && pages < LEDGER_MAX_PAGES);

  collected.sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')));
  return collected;
}

/** Tokens per day, derived from ledger units (`*mtoken` SKUs are millions). */
const dailyTokenCache = new Map<number, { at: number; data: Map<string, DayView> }>();

async function loadDailyTotals(days: number): Promise<Map<string, DayView>> {
  const cached = dailyTokenCache.get(days);
  if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.data;

  const rows = await scanHistory(days);
  const out = new Map<string, DayView>();
  const requestIds = new Map<string, Set<string>>();
  for (const row of rows) {
    const day = (row.timestamp ?? '').slice(0, 10);
    if (!day) continue;
    const entry = out.get(day) ?? { date: day, usd: 0, input: 0, output: 0, cache: 0, charges: 0, requests: 0 };
    entry.usd += num(row.amount);
    entry.charges += 1;
    const requestId = (row.inferenceDetails as { requestId?: string } | null | undefined)?.requestId;
    if (requestId) {
      const set = requestIds.get(day) ?? new Set<string>();
      set.add(requestId);
      requestIds.set(day, set);
    }
    const sku = (row.sku ?? '').toLowerCase();
    if (sku.endsWith('-mtoken')) {
      const units = num(row.units) * 1_000_000;
      if (sku.includes('cache-input')) entry.cache += units;
      else if (sku.includes('input')) entry.input += units;
      else if (sku.includes('output')) entry.output += units;
    }
    out.set(day, entry);
  }
  for (const [day, ids] of requestIds) {
    const entry = out.get(day);
    if (entry) entry.requests = ids.size;
  }
  dailyTokenCache.set(days, { at: Date.now(), data: out });
  return out;
}

async function buildLedger(limit: number, days: number): Promise<{ ok: true; rows: LedgerRow[]; scanned: number; fetchedAt: number }> {
  const collected = await scanHistory(days);
  const rows: LedgerRow[] = collected.slice(-limit).reverse().map((row) => ({
    ts: row.timestamp ?? '',
    amount: num(row.amount),
    sku: row.sku ?? '',
    notes: row.notes ?? '',
    currency: row.currency ?? 'USD',
    units: num(row.units),
    unitPrice: num(row.pricePerUnitUsd),
    requestId: row.inferenceDetails?.requestId ?? null,
  }));
  return { ok: true, rows, scanned: collected.length, fetchedAt: Date.now() };
}

// ---------------------------------------------------------------- balance / key

async function buildBalance(): Promise<BalanceView> {
  const raw = (await getJson('/billing/balance')) as UpstreamBalance;
  const source = keySource();
  return {
    ok: true,
    usd: num(raw.balances?.usd),
    diem: num(raw.balances?.diem),
    bundledCredits: num(raw.balances?.bundledCredits),
    canConsume: Boolean(raw.canConsume),
    currency: raw.consumptionCurrency || 'USD',
    fetchedAt: Date.now(),
    key: { source: source.source, present: source.present },
  };
}

async function buildKey(): Promise<unknown> {
  const raw = (await getJson('/api_keys/rate_limits')) as UpstreamRateLimits;
  let exceeded = 0;
  try {
    const log = (await getJson('/api_keys/rate_limits/log')) as { count?: number };
    exceeded = num(log.count);
  } catch {
    /* the log endpoint is experimental; a failure must not hide the tier */
  }
  const data = raw.data ?? {};
  const limits = (data.rateLimits ?? []).map((entry) => ({
    model: entry.apiModelId ?? '',
    limits: (entry.rateLimits ?? []).map((l) => `${l.amount ?? 0} ${l.type ?? ''}`.trim()),
  }));
  return {
    ok: true,
    permitted: Boolean(data.accessPermitted),
    tier: data.apiTier?.id ?? null,
    charged: Boolean(data.apiTier?.isCharged),
    expiresAt: data.keyExpiration ?? null,
    nextEpochAt: data.nextEpochBegins ?? null,
    modelCount: limits.length,
    exceeded,
    limits: limits.slice(0, 50),
    fetchedAt: Date.now(),
  };
}

// ---------------------------------------------------------------- session

function openCodeDbPath(): string {
  const base = process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(base, 'opencode', 'opencode.db');
}

interface SessionUsage {
  ok: true;
  id: string;
  messages: number;
  cost: number;
  model: string | null;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  lastAt: number;
  source: string;
}

/**
 * Per-chat usage as OpenCode recorded it. Venice's ledger has no session id, so
 * this is deliberately separate from the billing figures above.
 */
function buildSessionUsage(id: string): SessionUsage {
  const path = openCodeDbPath();
  if (!existsSync(path)) {
    throw new UpstreamError(404, 'OpenCode database not found');
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db
      .prepare('select data, time_created from session_message where session_id = ?')
      .all(id) as { data: string; time_created: number }[];

    let cost = 0;
    let messages = 0;
    let input = 0;
    let output = 0;
    let reasoning = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let lastAt = 0;
    const models = new Map<string, number>();

    for (const row of rows) {
      let payload: {
        model?: { id?: string; providerID?: string };
        cost?: number;
        tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
      };
      try {
        payload = JSON.parse(row.data) as typeof payload;
      } catch {
        continue;
      }
      if (payload?.model?.providerID !== 'venice') continue;
      messages += 1;
      cost += num(payload.cost);
      const tokens = payload.tokens ?? {};
      input += num(tokens.input);
      output += num(tokens.output);
      reasoning += num(tokens.reasoning);
      cacheRead += num(tokens.cache?.read);
      cacheWrite += num(tokens.cache?.write);
      lastAt = Math.max(lastAt, num(row.time_created));
      const modelId = payload?.model?.id;
      if (modelId) models.set(modelId, (models.get(modelId) ?? 0) + 1);
    }

    const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
      ok: true,
      id,
      messages,
      cost,
      model,
      tokens: { input, output, reasoning, cacheRead, cacheWrite },
      lastAt,
      source: 'opencode.db',
    };
  } finally {
    db?.close();
  }
}

// ---------------------------------------------------------------- sessions

interface SessionRankRow {
  id: string;
  title: string;
  cost: number;
  requests: number;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  startedAt: number;
  lastMessageAt: number;
}

/**
 * Per-chat Venetian usage from OpenCode's database. These are OpenCode's
 * recorded costs, not Venice billing; the panel labels them as an estimate.
 */
function buildSessionRanking(days: number, limit: number): { ok: true; sessions: SessionRankRow[]; estimate: true } {
  const path = openCodeDbPath();
  if (!existsSync(path)) throw new UpstreamError(404, 'OpenCode database not found');
  const since = Date.now() - days * 86_400_000;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const messages = db
      .prepare('select session_id, data, time_created from session_message where time_created >= ?')
      .all(since) as { session_id: string; data: string; time_created: number }[];
    const meta = db.prepare('select id, parent_id, title, time_created from session_v2').all() as {
      id: string;
      parent_id: string | null;
      title: string | null;
      time_created: number | null;
    }[];

    const parentOf = new Map<string, string | null>();
    const titles = new Map<string, string>();
    const created = new Map<string, number>();
    for (const row of meta) {
      parentOf.set(row.id, row.parent_id ?? null);
      if (row.title) titles.set(row.id, row.title);
      if (row.time_created) created.set(row.id, row.time_created);
    }

    const rootOf = (id: string): string => {
      let current = id;
      for (let guard = 0; guard < 64; guard += 1) {
        const parent = parentOf.get(current);
        if (!parent) break;
        current = parent;
      }
      return current;
    };

    const sessions = new Map<string, SessionRankRow>();
    for (const row of messages) {
      let payload: {
        model?: { providerID?: string };
        cost?: number;
        tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
      };
      try {
        payload = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (payload?.model?.providerID !== 'venice') continue;

      const root = rootOf(row.session_id);
      const entry =
        sessions.get(root) ??
        ({
          id: root,
          title: titles.get(root) || root,
          cost: 0,
          requests: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          startedAt: created.get(root) ?? row.time_created,
          lastMessageAt: 0,
        } satisfies SessionRankRow);

      entry.cost += num(payload.cost);
      entry.requests += 1;
      entry.tokens.input += num(payload.tokens?.input);
      entry.tokens.output += num(payload.tokens?.output);
      entry.tokens.reasoning += num(payload.tokens?.reasoning);
      entry.tokens.cacheRead += num(payload.tokens?.cache?.read);
      entry.tokens.cacheWrite += num(payload.tokens?.cache?.write);
      entry.lastMessageAt = Math.max(entry.lastMessageAt, num(row.time_created));
      sessions.set(root, entry);
    }

    const ranked = [...sessions.values()].sort((a, b) => b.cost - a.cost).slice(0, limit);
    return { ok: true, sessions: ranked, estimate: true };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- status

interface StatusView {
  rows: unknown[];
  controls?: unknown[];
}

function fmtTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Host-drawn Work Status section (contributes.statusSection.source). */
async function buildStatusView(): Promise<StatusView> {
  const [summary, balance] = await Promise.all([buildSummary(30, false), buildBalance()]);
  const days = summary.byDate;
  const today = days[days.length - 1];
  const yesterday = days.length > 1 ? days[days.length - 2] : today;
  const week = days.slice(-7);
  const peak = week.reduce((best, day) => (day.usd > best.usd ? day : best), week[0]);
  const activeDays = week.filter((day) => day.usd > 0).length;

  const todayTokens = today
    ? [today.input > 0 ? `in ${fmtTokensShort(today.input)}` : '', today.output > 0 ? `out ${fmtTokensShort(today.output)}` : '', today.cache > 0 ? `cache ${fmtTokensShort(today.cache)}` : '']
        .filter(Boolean)
        .join(' · ')
    : '';

  const weekRange = week.length > 0 ? `${week[0].date.slice(5)} → ${week[week.length - 1].date.slice(5)}` : '7 days';

  return {
    rows: [
      {
        kind: 'line',
        id: 'balance',
        label: 'Balance',
        value: fmtUsd(balance.usd),
        tooltip: `Prepaid USD credit, ${balance.canConsume ? 'spendable' : 'blocked'}. Venice caches billing figures for up to 10 minutes.`,
        ...(balance.canConsume ? {} : { badge: { label: 'blocked', tone: 'warning' } }),
      },
      {
        kind: 'line',
        id: 'today',
        label: 'Today',
        value: fmtUsd(summary.todayUsd),
        tooltip: today
          ? `${today.date} UTC · ${today.charges} ${today.charges === 1 ? 'charge' : 'charges'}${todayTokens ? ` · ${todayTokens}` : ''}`
          : 'Venice billing, UTC day',
      },
      {
        kind: 'line',
        id: 'yesterday',
        label: 'Yesterday',
        value: fmtUsd(yesterday?.usd ?? 0),
        tooltip: yesterday
          ? yesterday.charges > 0
            ? `${yesterday.date} UTC · ${yesterday.charges} ${yesterday.charges === 1 ? 'charge' : 'charges'}`
            : `${yesterday.date} UTC · no billed calls`
          : 'Venice billing, UTC day',
      },
      {
        kind: 'line',
        id: 'week',
        label: '7 days',
        value: fmtUsd(summary.last7Usd),
        tooltip: `${weekRange} · ${fmtUsd(summary.last7Usd / 7)} per day · ${activeDays} active ${activeDays === 1 ? 'day' : 'days'}${peak && peak.usd > 0 ? ` · peak ${peak.date.slice(5)} ${fmtUsd(peak.usd)}` : ''}`,
      },
    ],
    controls: [{ kind: 'button', id: 'refresh', label: 'Refresh' }],
  };
}

// ---------------------------------------------------------------- server

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof MissingKeyError) {
    sendJson(res, 503, {
      ok: false,
      error: 'no-key',
      message: 'No Venice API key. Set VENICE_API_KEY or add it to the Venice MCP entry in opencode.json.',
      path: error.path,
    });
    return;
  }
  if (error instanceof UpstreamError) {
    const status = error.status === 401 || error.status === 403 ? 403 : 502;
    sendJson(res, status, {
      ok: false,
      error: error.status === 401 || error.status === 403 ? 'forbidden' : 'upstream',
      message: error.message,
      upstreamStatus: error.status,
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 500, { ok: false, error: 'internal', message });
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const auth = req.headers.authorization || '';
  if (TOKEN && auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('unauthorized');
    return;
  }

  const url = new URL(req.url || '/', 'http://127.0.0.1');

  void (async () => {
    try {
      if (url.pathname === '/health') {
        sendJson(res, 200, { ok: true, key: keySource().present });
        return;
      }

      if (url.pathname === '/balance') {
        sendJson(res, 200, await buildBalance());
        return;
      }

      if (url.pathname === '/key') {
        sendJson(res, 200, await buildKey());
        return;
      }

      if (url.pathname === '/summary') {
        const days = Math.min(Math.max(Number(url.searchParams.get('days') || 30) || 30, 1), 90);
        sendJson(res, 200, await buildSummary(days));
        return;
      }

      if (url.pathname === '/sessions') {
        const days = Math.min(Math.max(Number(url.searchParams.get('days') || 30) || 30, 1), 365);
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 20) || 20, 1), 100);
        sendJson(res, 200, buildSessionRanking(days, limit));
        return;
      }

      if (url.pathname === '/session') {
        const id = (url.searchParams.get('id') || '').trim();
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
          sendJson(res, 400, { ok: false, error: 'bad-id' });
          return;
        }
        sendJson(res, 200, buildSessionUsage(id));
        return;
      }

      if (url.pathname === '/status') {
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          if (body?.id === 'refresh') {
            summaryCache.clear();
            dailyTokenCache.clear();
          }
        }
        sendJson(res, 200, await buildStatusView());
        return;
      }

      if (url.pathname === '/ledger') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 10) || 10, 1), 200);
        const days = Math.min(Math.max(Number(url.searchParams.get('days') || 7) || 7, 1), 90);
        sendJson(res, 200, await buildLedger(limit, days));
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not-found' });
    } catch (error) {
      sendError(res, error);
    }
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[venice-usage] service listening on 127.0.0.1:${PORT}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
