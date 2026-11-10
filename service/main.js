"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// service/main.ts
var main_exports = {};
module.exports = __toCommonJS(main_exports);
var import_node_http = require("node:http");
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_node_sqlite = require("node:sqlite");
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT || 0);
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN || "";
var API_BASE = "https://api.venice.ai/api/v1";
var UPSTREAM_TIMEOUT_MS = 2e4;
var SUMMARY_TTL_MS = 6e4;
var LEDGER_PAGE_SIZE = 1e3;
var LEDGER_MAX_PAGES = 5;
var MissingKeyError = class extends Error {
  path;
  constructor(path) {
    super(`No Venice API key found. Looked for VENICE_API_KEY and ${path}`);
    this.name = "MissingKeyError";
    this.path = path;
  }
};
var UpstreamError = class extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
};
var keyCache = null;
function configHome() {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? xdg : (0, import_node_path.join)((0, import_node_os.homedir)(), ".config");
}
function stripComments(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}
function parseConfig(text) {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripComments(text));
  }
}
function readConfiguredKey(path) {
  if (!(0, import_node_fs.existsSync)(path)) return null;
  let doc;
  try {
    doc = parseConfig((0, import_node_fs.readFileSync)(path, "utf8"));
  } catch {
    return null;
  }
  const root = doc;
  const mcp = root?.mcp;
  const servers = mcp?.servers;
  const venice = servers?.venice ?? mcp?.venice;
  const env = venice?.environment;
  const value = env?.VENICE_API_KEY ?? venice?.apiKey;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}
function resolveKey() {
  if (keyCache) return keyCache;
  const fromEnv = process.env.VENICE_API_KEY?.trim();
  if (fromEnv) {
    keyCache = { key: fromEnv, source: "env", path: null };
    return keyCache;
  }
  const candidates = [
    (0, import_node_path.join)(configHome(), "opencode", "opencode.json"),
    (0, import_node_path.join)(configHome(), "opencode", "opencode.jsonc")
  ];
  for (const path of candidates) {
    const key = readConfiguredKey(path);
    if (key) {
      keyCache = { key, source: "opencode.json", path };
      return keyCache;
    }
  }
  throw new MissingKeyError(candidates[0]);
}
function keySource() {
  try {
    const info = resolveKey();
    return { source: info.source, path: info.path, present: true };
  } catch {
    return { source: null, path: null, present: false };
  }
}
async function getJson(path) {
  const { key } = resolveKey();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error) detail = parsed.error;
    } catch {
    }
    throw new UpstreamError(res.status, detail || `HTTP ${res.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError(502, "Venice returned unparseable JSON");
  }
}
function fmtUsd(value) {
  const abs = Math.abs(value);
  if (!Number.isFinite(value)) return "$0";
  if (abs >= 1e3) return `$${value.toFixed(0)}`;
  if (abs >= 100) return `$${value.toFixed(1)}`;
  if (abs >= 1) return `$${value.toFixed(2)}`;
  if (abs === 0) return "$0";
  if (abs >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(5)}`;
}
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
var num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function breakdownUsd(row, label) {
  const wanted = label.toLowerCase();
  let total = 0;
  for (const part of row.breakdown ?? []) {
    if ((part.type ?? "").toLowerCase() === wanted) total += num(part.usd);
  }
  return total;
}
function toModelViews(rows) {
  return rows.map((row) => ({
    name: row.modelName ?? "unknown",
    type: row.modelType ?? "",
    unitType: row.unitType ?? "",
    units: num(row.totalUnits),
    usd: num(row.totalUsd),
    input: breakdownUsd(row, "Input"),
    output: breakdownUsd(row, "Output"),
    cacheRead: breakdownUsd(row, "Cache Read"),
    cacheWrite: breakdownUsd(row, "Cache Write")
  })).sort((a, b) => b.usd - a.usd);
}
function fillDays(byDate, days) {
  const byKey = new Map(byDate.map((d) => [d.date, d.usd]));
  const out = [];
  const today = Date.now();
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = utcDate(today - i * 864e5);
    out.push({ date, usd: byKey.get(date) ?? 0 });
  }
  return out;
}
var summaryCache = /* @__PURE__ */ new Map();
async function buildSummary(days, withTokens = true) {
  const cacheKey = `${days}:${withTokens ? 1 : 0}`;
  const cached = summaryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.data;
  const raw = await getJson(`/billing/usage-analytics?lookback=${days}d`);
  const rawDays = (raw.byDate ?? []).filter((row) => typeof row.date === "string" && row.date).map((row) => ({ date: row.date, usd: num(row.USD) }));
  let totals = /* @__PURE__ */ new Map();
  if (withTokens) {
    try {
      totals = await loadDailyTotals(days);
    } catch {
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
      requests: extra ? extra.requests : 0
    };
  });
  const perDay = new Map(rawDays.map((d) => [d.date, d.usd]));
  const todayKey = utcDate(Date.now());
  const todayUsd = perDay.get(todayKey) ?? 0;
  let last7Usd = 0;
  for (let i = 0; i < 7; i += 1) last7Usd += perDay.get(utcDate(Date.now() - i * 864e5)) ?? 0;
  const totalUsd = rawDays.reduce((sum, d) => sum + d.usd, 0);
  const byKey = (raw.byKey ?? []).map((row) => ({
    id: row.apiKeyId ?? "",
    name: row.description || "unnamed key",
    usd: num(row.totalUsd),
    units: num(row.totalUnits)
  }));
  const data = {
    ok: true,
    days,
    totalUsd,
    todayUsd,
    last7Usd,
    byDate,
    byModel: toModelViews(raw.byModel ?? []),
    byKey,
    fetchedAt: Date.now(),
    cachedAt: cached?.at ?? 0
  };
  summaryCache.set(cacheKey, { at: Date.now(), data });
  return data;
}
async function scanHistory(days) {
  const end = /* @__PURE__ */ new Date();
  const start = new Date(end.getTime() - days * 864e5);
  const filters = new URLSearchParams({
    pageSize: String(LEDGER_PAGE_SIZE),
    startTimestamp: start.toISOString(),
    endTimestamp: end.toISOString()
  });
  const collected = [];
  let cursor = null;
  let pages = 0;
  do {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : `?${filters.toString()}`;
    const raw = await getJson(`/billing/usage-history${query}`);
    collected.push(...raw.data ?? []);
    cursor = raw.nextCursor ?? null;
    pages += 1;
  } while (cursor && pages < LEDGER_MAX_PAGES);
  collected.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  return collected;
}
var dailyTokenCache = /* @__PURE__ */ new Map();
async function loadDailyTotals(days) {
  const cached = dailyTokenCache.get(days);
  if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.data;
  const rows = await scanHistory(days);
  const out = /* @__PURE__ */ new Map();
  const requestIds = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const day = (row.timestamp ?? "").slice(0, 10);
    if (!day) continue;
    const entry = out.get(day) ?? { date: day, usd: 0, input: 0, output: 0, cache: 0, charges: 0, requests: 0 };
    entry.usd += num(row.amount);
    entry.charges += 1;
    const requestId = row.inferenceDetails?.requestId;
    if (requestId) {
      const set = requestIds.get(day) ?? /* @__PURE__ */ new Set();
      set.add(requestId);
      requestIds.set(day, set);
    }
    const sku = (row.sku ?? "").toLowerCase();
    if (sku.endsWith("-mtoken")) {
      const units = num(row.units) * 1e6;
      if (sku.includes("cache-input")) entry.cache += units;
      else if (sku.includes("input")) entry.input += units;
      else if (sku.includes("output")) entry.output += units;
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
async function buildLedger(limit, days) {
  const collected = await scanHistory(days);
  const rows = collected.slice(-limit).reverse().map((row) => ({
    ts: row.timestamp ?? "",
    amount: num(row.amount),
    sku: row.sku ?? "",
    notes: row.notes ?? "",
    currency: row.currency ?? "USD",
    units: num(row.units),
    unitPrice: num(row.pricePerUnitUsd),
    requestId: row.inferenceDetails?.requestId ?? null
  }));
  return { ok: true, rows, scanned: collected.length, fetchedAt: Date.now() };
}
async function buildBalance() {
  const raw = await getJson("/billing/balance");
  const source = keySource();
  return {
    ok: true,
    usd: num(raw.balances?.usd),
    diem: num(raw.balances?.diem),
    bundledCredits: num(raw.balances?.bundledCredits),
    canConsume: Boolean(raw.canConsume),
    currency: raw.consumptionCurrency || "USD",
    fetchedAt: Date.now(),
    key: { source: source.source, present: source.present }
  };
}
async function buildKey() {
  const raw = await getJson("/api_keys/rate_limits");
  let exceeded = 0;
  try {
    const log = await getJson("/api_keys/rate_limits/log");
    exceeded = num(log.count);
  } catch {
  }
  const data = raw.data ?? {};
  const limits = (data.rateLimits ?? []).map((entry) => ({
    model: entry.apiModelId ?? "",
    limits: (entry.rateLimits ?? []).map((l) => `${l.amount ?? 0} ${l.type ?? ""}`.trim())
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
    fetchedAt: Date.now()
  };
}
function openCodeDbPath() {
  const base = process.env.XDG_DATA_HOME?.trim() || (0, import_node_path.join)((0, import_node_os.homedir)(), ".local", "share");
  return (0, import_node_path.join)(base, "opencode", "opencode.db");
}
function buildSessionUsage(id) {
  const path = openCodeDbPath();
  if (!(0, import_node_fs.existsSync)(path)) {
    throw new UpstreamError(404, "OpenCode database not found");
  }
  let db = null;
  try {
    db = new import_node_sqlite.DatabaseSync(path, { readOnly: true });
    const rows = db.prepare("select data, time_created from session_message where session_id = ?").all(id);
    let cost = 0;
    let messages = 0;
    let input = 0;
    let output = 0;
    let reasoning = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let lastAt = 0;
    const models = /* @__PURE__ */ new Map();
    for (const row of rows) {
      let payload;
      try {
        payload = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (payload?.model?.providerID !== "venice") continue;
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
      source: "opencode.db"
    };
  } finally {
    db?.close();
  }
}
function buildSessionRanking(days, limit) {
  const path = openCodeDbPath();
  if (!(0, import_node_fs.existsSync)(path)) throw new UpstreamError(404, "OpenCode database not found");
  const since = Date.now() - days * 864e5;
  const db = new import_node_sqlite.DatabaseSync(path, { readOnly: true });
  try {
    const messages = db.prepare("select session_id, data, time_created from session_message where time_created >= ?").all(since);
    const meta = db.prepare("select id, parent_id, title, time_created from session_v2").all();
    const parentOf = /* @__PURE__ */ new Map();
    const titles = /* @__PURE__ */ new Map();
    const created = /* @__PURE__ */ new Map();
    for (const row of meta) {
      parentOf.set(row.id, row.parent_id ?? null);
      if (row.title) titles.set(row.id, row.title);
      if (row.time_created) created.set(row.id, row.time_created);
    }
    const rootOf = (id) => {
      let current = id;
      for (let guard = 0; guard < 64; guard += 1) {
        const parent = parentOf.get(current);
        if (!parent) break;
        current = parent;
      }
      return current;
    };
    const sessions = /* @__PURE__ */ new Map();
    for (const row of messages) {
      let payload;
      try {
        payload = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (payload?.model?.providerID !== "venice") continue;
      const root = rootOf(row.session_id);
      const entry = sessions.get(root) ?? {
        id: root,
        title: titles.get(root) || root,
        cost: 0,
        requests: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        startedAt: created.get(root) ?? row.time_created,
        lastMessageAt: 0
      };
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
function fmtTokensShort(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(0)}K`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
async function buildStatusView() {
  const [summary, balance] = await Promise.all([buildSummary(30, false), buildBalance()]);
  const days = summary.byDate;
  const today = days[days.length - 1];
  const yesterday = days.length > 1 ? days[days.length - 2] : today;
  const week = days.slice(-7);
  const peak = week.reduce((best, day) => day.usd > best.usd ? day : best, week[0]);
  const activeDays = week.filter((day) => day.usd > 0).length;
  const todayTokens = today ? [today.input > 0 ? `in ${fmtTokensShort(today.input)}` : "", today.output > 0 ? `out ${fmtTokensShort(today.output)}` : "", today.cache > 0 ? `cache ${fmtTokensShort(today.cache)}` : ""].filter(Boolean).join(" \xB7 ") : "";
  const weekRange = week.length > 0 ? `${week[0].date.slice(5)} \u2192 ${week[week.length - 1].date.slice(5)}` : "7 days";
  return {
    rows: [
      {
        kind: "line",
        id: "balance",
        label: "Balance",
        value: fmtUsd(balance.usd),
        tooltip: `Prepaid USD credit, ${balance.canConsume ? "spendable" : "blocked"}. Venice caches billing figures for up to 10 minutes.`,
        ...balance.canConsume ? {} : { badge: { label: "blocked", tone: "warning" } }
      },
      {
        kind: "line",
        id: "today",
        label: "Today",
        value: fmtUsd(summary.todayUsd),
        tooltip: today ? `${today.date} UTC \xB7 ${today.charges} ${today.charges === 1 ? "charge" : "charges"}${todayTokens ? ` \xB7 ${todayTokens}` : ""}` : "Venice billing, UTC day"
      },
      {
        kind: "line",
        id: "yesterday",
        label: "Yesterday",
        value: fmtUsd(yesterday?.usd ?? 0),
        tooltip: yesterday ? yesterday.charges > 0 ? `${yesterday.date} UTC \xB7 ${yesterday.charges} ${yesterday.charges === 1 ? "charge" : "charges"}` : `${yesterday.date} UTC \xB7 no billed calls` : "Venice billing, UTC day"
      },
      {
        kind: "line",
        id: "week",
        label: "7 days",
        value: fmtUsd(summary.last7Usd),
        tooltip: `${weekRange} \xB7 ${fmtUsd(summary.last7Usd / 7)} per day \xB7 ${activeDays} active ${activeDays === 1 ? "day" : "days"}${peak && peak.usd > 0 ? ` \xB7 peak ${peak.date.slice(5)} ${fmtUsd(peak.usd)}` : ""}`
      }
    ],
    controls: [{ kind: "button", id: "refresh", label: "Refresh" }]
  };
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}
function sendError(res, error) {
  if (error instanceof MissingKeyError) {
    sendJson(res, 503, {
      ok: false,
      error: "no-key",
      message: "No Venice API key. Set VENICE_API_KEY or add it to the Venice MCP entry in opencode.json.",
      path: error.path
    });
    return;
  }
  if (error instanceof UpstreamError) {
    const status = error.status === 401 || error.status === 403 ? 403 : 502;
    sendJson(res, status, {
      ok: false,
      error: error.status === 401 || error.status === 403 ? "forbidden" : "upstream",
      message: error.message,
      upstreamStatus: error.status
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 500, { ok: false, error: "internal", message });
}
var server = (0, import_node_http.createServer)((req, res) => {
  const auth = req.headers.authorization || "";
  if (TOKEN && auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("unauthorized");
    return;
  }
  const url = new URL(req.url || "/", "http://127.0.0.1");
  void (async () => {
    try {
      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true, key: keySource().present });
        return;
      }
      if (url.pathname === "/balance") {
        sendJson(res, 200, await buildBalance());
        return;
      }
      if (url.pathname === "/key") {
        sendJson(res, 200, await buildKey());
        return;
      }
      if (url.pathname === "/summary") {
        const days = Math.min(Math.max(Number(url.searchParams.get("days") || 30) || 30, 1), 90);
        sendJson(res, 200, await buildSummary(days));
        return;
      }
      if (url.pathname === "/sessions") {
        const days = Math.min(Math.max(Number(url.searchParams.get("days") || 30) || 30, 1), 365);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20) || 20, 1), 100);
        sendJson(res, 200, buildSessionRanking(days, limit));
        return;
      }
      if (url.pathname === "/session") {
        const id = (url.searchParams.get("id") || "").trim();
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
          sendJson(res, 400, { ok: false, error: "bad-id" });
          return;
        }
        sendJson(res, 200, buildSessionUsage(id));
        return;
      }
      if (url.pathname === "/status") {
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          if (body?.id === "refresh") {
            summaryCache.clear();
            dailyTokenCache.clear();
          }
        }
        sendJson(res, 200, await buildStatusView());
        return;
      }
      if (url.pathname === "/ledger") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 10) || 10, 1), 200);
        const days = Math.min(Math.max(Number(url.searchParams.get("days") || 7) || 7, 1), 90);
        sendJson(res, 200, await buildLedger(limit, days));
        return;
      }
      sendJson(res, 404, { ok: false, error: "not-found" });
    } catch (error) {
      sendError(res, error);
    }
  })();
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[venice-usage] service listening on 127.0.0.1:${PORT}`);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
