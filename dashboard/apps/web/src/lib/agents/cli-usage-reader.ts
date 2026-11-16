/**
 * The program that reads what a coding CLI recorded about its own usage, run
 * with the machine's `node` inside a session's container. It prints one line
 * of JSON: the tokens and any cost the tool reported, summed per provider and
 * model, so what crosses back is a few rows however long the session ran.
 *
 * Every source, field and rule below is the tool's own format as Agent
 * Orchestrator reads it - `backend/internal/observe/usage/parser_*.go` and the
 * roots in `service/usage/collector.go` - and nothing else:
 *
 * - OpenCode: `step-finish` parts in `opencode*.db` (`part` joined to
 *   `message` for `providerID`/`modelID`), `tokens.{input,output,reasoning,
 *   cache.read,cache.write}` and `cost`; a zero cost counts only from
 *   OpenCode's own gateways.
 * - Goose: `usage_ledger` joined to `sessions` in `sessions/sessions.db`;
 *   `input_tokens` includes the cached ones; `carried_forward` rows skipped;
 *   `cost` counts when `cost_source` is `provider_reported`.
 * - Qwen Code: `usage/token-usage-YYYY-MM.jsonl` under its runtime folder,
 *   schemaVersion 1 records; `thoughtsTokens` are output only for Gemini
 *   routes or when `totalTokens` says they were counted apart.
 * - Grok CLI: `sessions/<dir>/<id>/usage.json`, per turn and model, cost in
 *   `costUsdTicks` (1e10 per USD).
 * - Pi, Oh My Pi and Kimchi: session JSONL files; assistant `message.usage`,
 *   `usage`/`model_usage` side records, and tool-result, compaction and
 *   branch-summary usage filed under "Tools/summaries".
 * - DeepSeek harness: zstd-compressed `sessions/<dir>/<id>/session.v4.jsonl.zstd`
 *   under `DSH_HOME` (else `~/.dsh`), a `session` header then
 *   `assistant/message` records with `data.usage` (input uncached) and
 *   `data.message.source.{provider,model}`. Decoded with Node's own zstd
 *   (22.15 / 23.8 and later); skipped where it is missing.
 * - Codex: `rollout-*.jsonl` `token_count` events, the cumulative
 *   `total_token_usage` turned into deltas from a baseline, the model from
 *   `turn_context`.
 *
 * Ported from Agent Orchestrator (Apache-2.0), backend/internal/observe/usage
 * (parser_opencode.go, parser_goose.go, parser_qwen.go, parser_grok.go,
 * parser_pi.go, parser_deepseek.go, parser.go parseCodexEvent).
 *
 * Plain CommonJS that runs on any Node with `node:sqlite` (22.13 and later;
 * the session image is `node:24`). Reads only, bounded: the newest 200 files
 * per tool, none over 32 MiB, 64 rows out. No file is written.
 */

export const USAGE_READER_JS = String.raw`"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const E = process.env;
const H = (E.POLARIS_HOME && path.isAbsolute(E.POLARIS_HOME) ? E.POLARIS_HOME : "") || os.homedir();
const MAX_FILES = 200, MAX_BYTES = 33554432, MAX_ROWS = 64;
const rows = new Map();
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const money = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const abs = (v) => { const t = str(v); return t && path.isAbsolute(t) ? t : ""; };
function add(p, m, i, o, cr, cw, cost, n) {
    m = str(m).slice(0, 128); p = str(p).slice(0, 64);
    if (!m || i + o + cr + cw === 0) return;
    const f = cost === null ? 0 : 1;
    const key = JSON.stringify([p, m, f]);
    let r = rows.get(key);
    if (!r) { if (rows.size >= MAX_ROWS) return; r = { p, m, f, i: 0, o: 0, cr: 0, cw: 0, c: 0, n: 0 }; rows.set(key, r); }
    r.i += i; r.o += o; r.cr += cr; r.cw += cw; r.n += n || 1; if (cost !== null) r.c += cost;
}
function files(root, test, depth) {
    const found = [];
    const walk = (dir, left) => {
        let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory() && left > 0) walk(full, left - 1);
            else if (e.isFile() && test(e.name)) { try { found.push({ full, at: fs.statSync(full).mtimeMs }); } catch {} }
        }
    };
    if (root) walk(root, depth);
    return found.sort((a, b) => b.at - a.at).slice(0, MAX_FILES).map((x) => x.full);
}
function text(file) {
    try { if (fs.statSync(file).size > MAX_BYTES) return null; return fs.readFileSync(file, "utf8"); } catch { return null; }
}
function* records(file) {
    const body = text(file); if (body === null) return;
    for (const line of body.split("\n")) { if (!line.trim()) continue; try { const v = JSON.parse(line); if (v && typeof v === "object") yield v; } catch {} }
}
function query(file, sql) {
    let db; try { const { DatabaseSync } = require("node:sqlite"); db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(); }
    catch { return []; } finally { try { if (db) db.close(); } catch {} }
}
function dataHome(app, envName) {
    return abs(E[envName]) || path.join(abs(E.XDG_DATA_HOME) || path.join(H, ".local", "share"), app);
}
function opencode() {
    const gateways = "'opencode','kilo','kilocode'";
    const sql = "SELECT provider p, model m, f, SUM(i) i, SUM(o) o, SUM(cr) cr, SUM(cw) cw, SUM(c) c, COUNT(*) n FROM (" +
        "SELECT COALESCE(json_extract(m.data,'$.providerID'),'') provider, COALESCE(json_extract(m.data,'$.modelID'),'') model," +
        " COALESCE(json_extract(p.data,'$.tokens.input'),0) i," +
        " COALESCE(json_extract(p.data,'$.tokens.output'),0) + COALESCE(json_extract(p.data,'$.tokens.reasoning'),0) o," +
        " COALESCE(json_extract(p.data,'$.tokens.cache.read'),0) cr, COALESCE(json_extract(p.data,'$.tokens.cache.write'),0) cw," +
        " json_extract(p.data,'$.cost') c," +
        " CASE WHEN json_type(p.data,'$.cost') IN ('real','integer') AND (json_extract(p.data,'$.cost') > 0 OR" +
        " COALESCE(json_extract(m.data,'$.providerID'),'') IN (" + gateways + ")) THEN 1 ELSE 0 END f" +
        " FROM part p JOIN message m ON m.id = p.message_id" +
        " WHERE json_valid(p.data) AND json_valid(m.data) AND json_extract(p.data,'$.type') = 'step-finish'" +
        " AND json_type(p.data,'$.tokens') = 'object'" +
        ") GROUP BY provider, model, f LIMIT " + MAX_ROWS;
    const dbName = /^opencode(-[a-z0-9][a-z0-9._]*)?\.db$/;
    for (const file of files(dataHome("opencode", "OPENCODE_DATA_DIR"), (n) => dbName.test(n), 0))
        for (const r of query(file, sql)) add(r.p, r.m, num(r.i), num(r.o), num(r.cr), num(r.cw), r.f ? money(r.c) : null, num(r.n));
}
function goose() {
    const root = abs(E.GOOSE_PATH_ROOT) ? path.join(abs(E.GOOSE_PATH_ROOT), "data") : dataHome("goose", "");
    const sql = "SELECT COALESCE(s.provider_name,'') p, COALESCE(u.model,'') m," +
        " CASE WHEN u.cost_source = 'provider_reported' AND u.cost IS NOT NULL THEN 1 ELSE 0 END f," +
        " SUM(COALESCE(u.input_tokens,0)) ti, SUM(COALESCE(u.output_tokens,0)) o," +
        " SUM(COALESCE(u.cache_read_tokens,0)) cr, SUM(COALESCE(u.cache_write_tokens,0)) cw, SUM(u.cost) c, COUNT(*) n" +
        " FROM usage_ledger u JOIN sessions s ON s.id = u.session_id" +
        " WHERE COALESCE(u.cost_source,'') <> 'carried_forward' AND u.id > 0" +
        " GROUP BY 1, 2, 3 LIMIT " + MAX_ROWS;
    const file = path.join(root, "sessions", "sessions.db");
    if (!fs.existsSync(file)) return;
    for (const r of query(file, sql)) {
        const cr = num(r.cr), cw = num(r.cw);
        add(r.p, r.m, Math.max(0, num(r.ti) - cr - cw), num(r.o), cr, cw, r.f ? money(r.c) : null, num(r.n));
    }
}
function qwenPath(v) {
    const t = str(v);
    if (t === "~") return H;
    if (t.startsWith("~/") || t.startsWith("~\\")) return path.join(H, t.slice(2));
    if (path.isAbsolute(t)) return path.normalize(t);
    return path.join(H, t);
}
function qwen() {
    let root = str(E.QWEN_RUNTIME_DIR) ? qwenPath(E.QWEN_RUNTIME_DIR) : "";
    if (!root) {
        const home = str(E.QWEN_HOME) ? qwenPath(E.QWEN_HOME) : path.join(H, ".qwen");
        let configured = "";
        try { const s = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")); configured = str(s && s.advanced && s.advanced.runtimeOutputDir); } catch {}
        root = configured ? qwenPath(configured) : home;
    }
    const seen = new Set();
    const name = /^token-usage-\d{4}-\d{2}\.jsonl$/;
    for (const file of files(path.join(root, "usage"), (n) => name.test(n), 0)) for (const r of records(file)) {
        const model = str(r.model), id = str(r.id);
        if (r.schemaVersion !== 1 || !model || !id) continue;
        const key = id + "\n" + model; if (seen.has(key)) continue; seen.add(key);
        const input = num(r.inputTokens), cached = Math.min(num(r.cachedTokens), input);
        let out = num(r.outputTokens);
        const thoughts = num(r.thoughtsTokens), auth = str(r.authType);
        if (auth === "gemini" || auth === "vertex-ai") out += thoughts;
        else if (!["openai", "openai-responses", "qwen-oauth", "anthropic"].includes(auth) && thoughts > 0 &&
            typeof r.totalTokens === "number" && r.totalTokens === input + num(r.outputTokens) + thoughts) out += thoughts;
        add("", model, input - cached, out, cached, 0, null, 1);
    }
}
function grok() {
    const root = path.join(abs(E.GROK_HOME) || path.join(H, ".grok"), "sessions");
    for (const file of files(root, (n) => n === "usage.json", 2)) {
        let doc; try { doc = JSON.parse(text(file) || "null"); } catch { continue; }
        if (!doc || !Array.isArray(doc.turns)) continue;
        for (const turn of doc.turns) {
            if (!turn || !(num(turn.turnNumber) > 0)) continue;
            let usage = turn.modelUsage && typeof turn.modelUsage === "object" ? turn.modelUsage : {};
            if (Object.keys(usage).length === 0 && str(turn.primaryModelId)) usage = { [str(turn.primaryModelId)]: turn };
            for (const model of Object.keys(usage).sort().slice(0, 256)) {
                const u = usage[model] || {};
                const input = num(u.inputTokens), cr = num(u.cachedReadTokens), cw = num(u.cacheCreationTokens);
                if (input === 0 && num(u.outputTokens) === 0) continue;
                if (cr > input || cw > input - cr) continue;
                const ticks = num(u.costUsdTicks);
                add("xai", model, input - cr - cw, num(u.outputTokens), cr, cw, ticks > 0 ? ticks / 1e10 : null, 1);
            }
        }
    }
}
const PI = {
    pi: { env: "PI_CODING_AGENT_DIR", parts: [".pi", "agent"], side: "", gateways: [] },
    omp: { env: "PI_CODING_AGENT_DIR", parts: [".omp", "agent"], side: "model_usage", gateways: [] },
    kimchi: { env: "KIMCHI_CODING_AGENT_DIR", parts: [".config", "kimchi", "harness"], side: "", gateways: ["kimchi", "kimchi-dev"] }
};
function piDir(env, parts) {
    let dir = str(E[env]);
    if (dir === "~") dir = H; else if (dir.startsWith("~/")) dir = path.join(H, dir.slice(2));
    return dir && path.isAbsolute(dir) ? path.normalize(dir) : path.join(H, ...parts);
}
function pi(family) {
    const seen = new Set();
    for (const file of files(path.join(piDir(family.env, family.parts), "sessions"), (n) => n.endsWith(".jsonl"), 1)) for (const r of records(file)) {
        let provider = "", model = "", usage = null;
        const msg = r.message && typeof r.message === "object" ? r.message : null;
        const reported = (v) => v && typeof v === "object";
        if (r.type === "message" && msg && msg.role === "assistant") {
            if (!reported(msg.usage)) continue;
            provider = str(msg.provider); model = str(msg.responseModel) || str(msg.model); usage = msg.usage;
        } else if (r.type === "usage" || (family.side && r.type === family.side)) {
            provider = str(r.provider); model = str(r.model); usage = r.usage;
            if (!provider || !model || !reported(usage)) continue;
        } else if (r.type === "message" && msg && msg.role === "toolResult" && reported(msg.usage)) {
            model = "Tools/summaries"; usage = msg.usage;
        } else if ((r.type === "compaction" || r.type === "branch_summary") && reported(r.usage)) {
            model = "Tools/summaries"; usage = r.usage;
        } else continue;
        if (!model) continue;
        const id = str(r.id);
        if (id) { const key = r.type + "\n" + id; if (seen.has(key)) continue; seen.add(key); }
        const c = reported(usage.cost) ? usage.cost : null;
        const total = c ? money(c.input) + money(c.output) + money(c.cacheRead) + money(c.cacheWrite) : 0;
        const own = model !== "Tools/summaries" && family.gateways.includes(provider);
        add(model === "Tools/summaries" ? "" : provider, model, num(usage.input), num(usage.output), num(usage.cacheRead), num(usage.cacheWrite),
            c && (total > 0 || own) ? total : null, 1);
    }
}
function codex() {
    const home = abs(E.CODEX_HOME) || path.join(H, ".codex");
    const name = (n) => n.startsWith("rollout-") && n.endsWith(".jsonl");
    const seen = new Set();
    const keys = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
    const vec = (v) => { const o = {}; for (const k of keys) o[k] = v && typeof v[k] === "number" && Number.isFinite(v[k]) ? Math.floor(v[k]) : 0; return o; };
    const valid = (t) => keys.every((k) => t[k] >= 0) && t.cached_input_tokens <= t.input_tokens &&
        t.cache_write_input_tokens <= t.input_tokens - t.cached_input_tokens && t.reasoning_output_tokens <= t.output_tokens &&
        (t.total_tokens === 0 || t.total_tokens === t.input_tokens + t.output_tokens);
    for (const file of [...files(path.join(home, "sessions"), name, 3), ...files(path.join(home, "archived_sessions"), name, 3)]) {
        let model = "", provider = "", base = vec(null), first = true;
        for (const r of records(file)) {
            const p = r.payload && typeof r.payload === "object" ? r.payload : {};
            if (r.type === "session_meta") {
                if (first) { const id = str(p.id); if (id && seen.has(id)) break; if (id) seen.add(id); }
                provider = str(p.model_provider) || provider;
            } else if (r.type === "turn_context") model = str(p.model) || model;
            first = false;
            if (r.type !== "event_msg" || p.type !== "token_count" || !p.info || typeof p.info !== "object") continue;
            const total = vec(p.info.total_token_usage), win = num(p.info.model_context_window);
            if (win > 0 && total.total_tokens === win && keys.slice(0, 5).every((k) => total[k] === 0)) { base = vec(null); continue; }
            if (!valid(total)) continue;
            if (keys.slice(0, 5).some((k) => total[k] < base[k])) { base = total; continue; }
            let d = {}; for (const k of keys) d[k] = total[k] - base[k];
            if (p.info.last_token_usage && typeof p.info.last_token_usage === "object") {
                const last = vec(p.info.last_token_usage);
                if (!valid(last)) { base = total; continue; }
                if (keys.slice(0, 5).some((k) => last[k] !== d[k])) d = last;
            }
            base = total;
            const cached = d.cached_input_tokens, write = d.cache_write_input_tokens;
            add(provider || "openai", model || "unknown", d.input_tokens - cached - write, d.output_tokens, cached, write, null, 1);
        }
    }
}
function deepseek() {
    // Node 22.15 / 23.8 and later; nothing is read where it is missing.
    const zlib = require("zlib");
    if (typeof zlib.zstdDecompressSync !== "function") return;
    const root = path.join(abs(E.DSH_HOME) || path.join(H, ".dsh"), "sessions");
    const seen = new Set();
    for (const file of files(root, (n) => n === "session.v4.jsonl.zstd", 2)) {
        let body;
        try {
            if (fs.statSync(file).size > 67108864) continue;
            body = zlib.zstdDecompressSync(fs.readFileSync(file), { maxOutputLength: 268435456 }).toString("utf8");
        } catch { continue; }
        const lines = body.split("\n");
        let header = null; try { header = JSON.parse(lines[0]); } catch {}
        if (!header || header.type !== "session") continue;
        for (const line of lines.slice(1)) {
            let r; try { r = JSON.parse(line); } catch { continue; }
            if (!r || r.type !== "assistant/message" || !r.data || typeof r.data !== "object") continue;
            const d = r.data, u = d.usage, msg = d.message && typeof d.message === "object" ? d.message : {};
            const src = msg.source && typeof msg.source === "object" ? msg.source : {};
            if (!u || typeof u !== "object" || typeof u.inputTokens !== "number" || typeof u.outputTokens !== "number") continue;
            const key = str(header.id) + "\n" + (str(msg.id) || "seq-" + num(r.seq));
            if (seen.has(key)) continue; seen.add(key);
            add(src.provider, src.model, num(u.inputTokens), num(u.outputTokens), num(u.cacheReadTokens), num(u.cacheWriteTokens), null, 1);
        }
    }
}
const readers = { opencode, goose, qwen, grok, codex, pi: () => pi(PI.pi), omp: () => pi(PI.omp), kimchi: () => pi(PI.kimchi), "deepseek-harness": deepseek };
const cli = process.argv[1];
if (Object.prototype.hasOwnProperty.call(readers, cli)) { try { readers[cli](); } catch {} }
process.stdout.write(JSON.stringify({ v: 1, rows: [...rows.values()] }) + "\n");
`;

/** The CLIs the program has a reader for, by catalogue id. */
export const USAGE_READER_CLIS: ReadonlySet<string> = new Set([
    "opencode",
    "goose",
    "qwen",
    "grok",
    "codex",
    "pi",
    "omp",
    "kimchi",
    "deepseek-harness"
]);
