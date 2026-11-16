/**
 * The usage program run for real, with `node`, against a home holding each
 * CLI's records in the shape the tool writes them.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { USAGE_READER_JS } from "@/lib/agents/cli-usage-reader";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { parseUsageAnswer, type UsageRow } from "@/lib/agents/cli-usage";

let home: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cli-usage-"));
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

function read(cli: string, env: Record<string, string> = {}): UsageRow[] {
    const output = execFileSync(process.execPath, ["-e", USAGE_READER_JS, cli], {
        env: { POLARIS_HOME: home, PATH: process.env.PATH ?? "", ...env },
        encoding: "utf8"
    });
    const rows = parseUsageAnswer(output);
    if (!rows) throw new Error(`not an answer: ${output}`);
    return rows;
}

function file(relative: string, body: string): string {
    const full = join(home, relative);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
    return full;
}

const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

/** A database built with the same `node:sqlite` the program reads it with. */
function database(relative: string, statements: string[]): void {
    const full = join(home, relative);
    mkdirSync(join(full, ".."), { recursive: true });
    const script = `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); for (const s of JSON.parse(process.argv[2])) db.exec(s); db.close();`;
    execFileSync(process.execPath, ["-e", script, full, JSON.stringify(statements)]);
}

const sql = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'`;

describe("OpenCode", () => {
    it("sums step-finish parts per model, taking a reported cost", () => {
        const step = (tokens: object, cost: number) => ({ type: "step-finish", tokens, cost });
        database(".local/share/opencode/opencode.db", [
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)",
            "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)",
            `INSERT INTO message VALUES ('m1', 's1', ${sql({ role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-4-5" })})`,
            `INSERT INTO part VALUES ('p1', 'm1', 's1', 1, ${sql(step({ input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 40 } }, 0.25))})`,
            `INSERT INTO part VALUES ('p2', 'm1', 's1', 2, ${sql(step({ input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, 0.05))})`,
            `INSERT INTO part VALUES ('p3', 'm1', 's1', 3, ${sql({ type: "text", text: "hello" })})`
        ]);
        expect(read("opencode")).toEqual([
            { p: "anthropic", m: "claude-sonnet-4-5", f: 1, i: 110, o: 27, cr: 300, cw: 40, c: 0.3, n: 2 }
        ]);
    });

    it("leaves a zero cost unpriced unless OpenCode's own gateway reported it", () => {
        database(".local/share/opencode/opencode.db", [
            "CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT)",
            "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)",
            `INSERT INTO message VALUES ('m1', ${sql({ providerID: "openai", modelID: "gpt-5" })})`,
            `INSERT INTO message VALUES ('m2', ${sql({ providerID: "opencode", modelID: "grok-code" })})`,
            `INSERT INTO part VALUES ('p1', 'm1', ${sql({ type: "step-finish", tokens: { input: 5, output: 1 }, cost: 0 })})`,
            `INSERT INTO part VALUES ('p2', 'm2', ${sql({ type: "step-finish", tokens: { input: 7, output: 3 }, cost: 0 })})`
        ]);
        const rows = read("opencode");
        expect(rows.find((row) => row.p === "openai")).toMatchObject({ f: 0, i: 5, o: 1 });
        expect(rows.find((row) => row.p === "opencode")).toMatchObject({ f: 1, c: 0, i: 7, o: 3 });
    });
});

describe("Goose", () => {
    it("reads the usage ledger, takes cached tokens out of the input and skips carried-forward rows", () => {
        database(".local/share/goose/sessions/sessions.db", [
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, provider_name TEXT)",
            "CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY, session_id TEXT, created_timestamp INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost REAL, cost_source TEXT, is_compaction INTEGER)",
            "INSERT INTO sessions VALUES ('g1', 'openai')",
            "INSERT INTO usage_ledger VALUES (1, 'g1', 1, 'gpt-5', 1000, 50, 1050, 600, 100, 0.02, 'provider_reported', 0)",
            "INSERT INTO usage_ledger VALUES (2, 'g1', 2, 'gpt-5', 400, 10, 410, 0, 0, NULL, 'estimated', 0)",
            "INSERT INTO usage_ledger VALUES (3, 'g1', 3, 'gpt-5', 999, 999, 1998, 0, 0, 9, 'carried_forward', 0)"
        ]);
        const rows = read("goose");
        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.f === 1)).toEqual({ p: "openai", m: "gpt-5", f: 1, i: 300, o: 50, cr: 600, cw: 100, c: 0.02, n: 1 });
        expect(rows.find((row) => row.f === 0)).toMatchObject({ i: 400, o: 10, cr: 0, cw: 0 });
    });

    it("follows GOOSE_PATH_ROOT", () => {
        database("custom/data/sessions/sessions.db", [
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, provider_name TEXT)",
            "CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost REAL, cost_source TEXT)",
            "INSERT INTO sessions VALUES ('g1', 'anthropic')",
            "INSERT INTO usage_ledger VALUES (1, 'g1', 'claude-haiku-4-5', 10, 2, NULL, NULL, NULL, NULL)"
        ]);
        expect(read("goose", { GOOSE_PATH_ROOT: join(home, "custom") })).toMatchObject([{ m: "claude-haiku-4-5", i: 10, o: 2 }]);
    });
});

describe("Qwen Code", () => {
    const record = (overrides: object) => ({
        schemaVersion: 1,
        id: "r1",
        timestamp: "2026-11-01T10:00:00Z",
        sessionId: "q1",
        model: "qwen3-coder-plus",
        authType: "qwen-oauth",
        inputTokens: 1000,
        outputTokens: 100,
        cachedTokens: 400,
        thoughtsTokens: 30,
        totalTokens: 1100,
        ...overrides
    });

    it("reads the monthly logs once per record and keeps thoughts out of a Qwen route's output", () => {
        file(
            ".qwen/usage/token-usage-2026-11.jsonl",
            jsonl(record({}), record({}), record({ id: "r2", schemaVersion: 2 })) + "not json\n"
        );
        file(".qwen/usage/token-usage-2026-10.jsonl", jsonl(record({ id: "r0", inputTokens: 10, cachedTokens: 0, outputTokens: 1 })));
        file(".qwen/usage/notes.jsonl", jsonl(record({ id: "x" })));
        expect(read("qwen")).toEqual([{ p: "", m: "qwen3-coder-plus", f: 0, i: 610, o: 101, cr: 400, cw: 0, c: 0, n: 2 }]);
    });

    it("counts thoughts as output on a Gemini route, under the runtime folder settings name", () => {
        file(".qwen/settings.json", JSON.stringify({ advanced: { runtimeOutputDir: "~/runtime" } }));
        file("runtime/usage/token-usage-2026-11.jsonl", jsonl(record({ authType: "gemini" })));
        expect(read("qwen")).toMatchObject([{ i: 600, o: 130, cr: 400 }]);
    });
});

describe("Grok CLI", () => {
    it("reads each turn per model with its reported cost in ticks", () => {
        file(
            ".grok/sessions/project/abc/usage.json",
            JSON.stringify({
                sessionId: "abc",
                turns: [
                    {
                        turnNumber: 1,
                        endedAt: "2026-11-01T10:00:00Z",
                        primaryModelId: "grok-4",
                        modelUsage: {
                            "grok-4": { inputTokens: 1000, outputTokens: 200, cachedReadTokens: 300, cacheCreationTokens: 0, reasoningTokens: 50, costUsdTicks: 25_000_000 }
                        }
                    },
                    { turnNumber: 2, primaryModelId: "grok-code-fast", inputTokens: 50, outputTokens: 5, cachedReadTokens: 0, cacheCreationTokens: 0 },
                    { turnNumber: 0, primaryModelId: "grok-4", inputTokens: 999, outputTokens: 999 }
                ]
            })
        );
        const rows = read("grok");
        expect(rows.find((row) => row.m === "grok-4")).toEqual({ p: "xai", m: "grok-4", f: 1, i: 700, o: 200, cr: 300, cw: 0, c: 0.0025, n: 1 });
        expect(rows.find((row) => row.m === "grok-code-fast")).toMatchObject({ f: 0, i: 50, o: 5 });
    });
});

describe("Pi family", () => {
    const assistant = (id: string, usage: object) => ({
        type: "message",
        id,
        timestamp: "2026-11-01T10:00:00Z",
        message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage }
    });

    it("sums assistant usage, reported costs, and tool and summary usage once per entry", () => {
        file(
            ".pi/agent/sessions/--work--/2026-11-01_s1.jsonl",
            jsonl(
                { type: "session", id: "s1", cwd: "/work" },
                assistant("a1", { input: 10, output: 20, cacheRead: 300, cacheWrite: 40, cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004 } }),
                assistant("a1", { input: 10, output: 20, cacheRead: 300, cacheWrite: 40 }),
                { type: "message", id: "t1", message: { role: "toolResult", usage: { input: 5, output: 1 } } },
                { type: "compaction", id: "c1", usage: { input: 50, output: 10 } },
                { type: "message", id: "u1", message: { role: "user", content: "hi" } }
            )
        );
        const rows = read("pi");
        expect(rows.find((row) => row.m === "claude-sonnet-4-5")).toEqual({
            p: "anthropic",
            m: "claude-sonnet-4-5",
            f: 1,
            i: 10,
            o: 20,
            cr: 300,
            cw: 40,
            c: expect.closeTo(0.037, 9),
            n: 1
        });
        expect(rows.find((row) => row.m === "Tools/summaries")).toMatchObject({ p: "", f: 0, i: 55, o: 11, n: 2 });
    });

    it("reads Oh My Pi's model_usage records only for omp", () => {
        const side = { type: "model_usage", id: "x1", provider: "openai", model: "gpt-5", usage: { input: 7, output: 3 } };
        file(".omp/agent/sessions/s.jsonl", jsonl(side));
        file(".pi/agent/sessions/s.jsonl", jsonl(side));
        expect(read("omp")).toMatchObject([{ p: "openai", m: "gpt-5", i: 7, o: 3 }]);
        expect(read("pi")).toEqual([]);
    });

    it("finds Kimchi under its own folder and honours its gateway's zero cost", () => {
        file(
            ".config/kimchi/harness/sessions/s.jsonl",
            jsonl({
                type: "message",
                id: "k1",
                message: { role: "assistant", provider: "kimchi", model: "kimi-k2", usage: { input: 9, output: 1, cost: { input: 0, output: 0 } } }
            })
        );
        expect(read("kimchi")).toMatchObject([{ p: "kimchi", f: 1, c: 0, i: 9, o: 1 }]);
    });
});

describe("Codex", () => {
    const tokenCount = (total: object, last?: object) => ({
        timestamp: "2026-11-01T10:00:00Z",
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: total, ...(last ? { last_token_usage: last } : {}), model_context_window: 272000 } }
    });
    const vector = (input: number, cached: number, output: number, reasoning = 0) => ({
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output
    });

    it("turns cumulative totals into deltas, attributed to the turn's model", () => {
        file(
            ".codex/sessions/2026/11/01/rollout-2026-11-01T10-00-00-c1.jsonl",
            jsonl(
                { type: "session_meta", payload: { id: "c1", model_provider: "openai" } },
                { type: "turn_context", payload: { model: "gpt-5-codex" } },
                tokenCount(vector(1000, 200, 100, 40)),
                tokenCount(vector(1000, 200, 100, 40)),
                tokenCount(vector(1500, 600, 180, 40), vector(500, 400, 80)),
                { timestamp: "t", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: vector(0, 0, 0), model_context_window: 272000 } } }
            )
        );
        // The same conversation moved to the archive is not counted twice.
        file(
            ".codex/archived_sessions/rollout-2026-11-01T10-00-00-c1.jsonl",
            jsonl({ type: "session_meta", payload: { id: "c1" } }, tokenCount(vector(9999, 0, 9999)))
        );
        const rows = read("codex");
        expect(rows).toEqual([{ p: "openai", m: "gpt-5-codex", f: 0, i: 900, o: 180, cr: 600, cw: 0, c: 0, n: 2 }]);
    });

    it("starts over when the totals go backwards instead of counting a negative", () => {
        file(
            ".codex/sessions/rollout-x.jsonl",
            jsonl(
                { type: "session_meta", payload: { id: "c2" } },
                tokenCount(vector(1000, 0, 100)),
                tokenCount(vector(300, 0, 30)),
                tokenCount(vector(400, 0, 40))
            )
        );
        expect(read("codex")).toEqual([{ p: "openai", m: "unknown", f: 0, i: 1100, o: 110, cr: 0, cw: 0, c: 0, n: 2 }]);
    });
});

describe("DeepSeek harness", () => {
    it("decodes the zstd session log and sums each assistant reply once", () => {
        const log = jsonl(
            { type: "session", id: "d1" },
            { type: "user/message", seq: 1, data: { text: "hi" } },
            { type: "assistant/message", seq: 2, data: { message: { id: "r1", source: { provider: "deepseek", model: "deepseek-chat" } }, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0 } } },
            { type: "assistant/message", seq: 3, data: { message: { id: "r1", source: { provider: "deepseek", model: "deepseek-chat" } }, usage: { inputTokens: 100, outputTokens: 20 } } },
            { type: "assistant/message", seq: 4, data: { message: { id: "r2", source: { provider: "deepseek", model: "deepseek-chat" } }, usage: { outputTokens: 5 } } }
        );
        const full = join(home, ".dsh/sessions/work/d1/session.v4.jsonl.zstd");
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, zstdCompressSync(Buffer.from(log)));
        // Not compressed: not a log the tool wrote, so nothing is read from it.
        file(".dsh/sessions/work/d2/session.v4.jsonl.zstd", log);
        expect(read("deepseek-harness")).toEqual([{ p: "deepseek", m: "deepseek-chat", f: 0, i: 100, o: 20, cr: 300, cw: 0, c: 0, n: 1 }]);
    });
});

describe("the program", () => {
    it("answers an empty list for a home with nothing in it, or a CLI it has no reader for", () => {
        expect(read("opencode")).toEqual([]);
        expect(read("claude")).toEqual([]);
        expect(read("constructor")).toEqual([]);
    });
});
