import { StdioPipe } from "./stdio-pipe";
import type * as core from "@polaris/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexNormalizer } from "@/lib/agents/codex/normalize";
import type { HistoryRow } from "@/lib/agents/transcript-decoders";
import type { PermissionStatus } from "@/lib/agents/session-permissions";
import { chatAvailable, usesAcp, usesAppServer } from "@/lib/agents/acp/providers";
import { CODEX_APP_SERVER_ARGV, decisionFor, hasAppServer, MODE_SETTINGS } from "@/lib/agents/codex/protocol";
import { CodexAppServerMissing, CodexSessionDriver, type CodexDriverDeps } from "@/lib/agents/codex/session-driver";

const NEW_HELP = "Usage: codex app-server [OPTIONS] [COMMAND]\n\nCommands:\n  generate-json-schema\n";
const OLD_HELP = "Codex CLI\n\nUsage: codex [OPTIONS] [PROMPT]\n       codex [OPTIONS] <COMMAND> [ARGS]\n";

const pipes: StdioPipe[] = [];
afterEach(() => {
    for (const pipe of pipes.splice(0)) pipe.stop();
});

function harness(options: {
    vendorSessionId?: string | null;
    mode?: core.SessionPermissionMode | null;
    answer?: PermissionStatus;
    help?: string | null;
} = {}) {
    const pipe = new StdioPipe();
    pipes.push(pipe);
    const rows: HistoryRow[] = [];
    const events: { kind: string; detail: string; subject: string }[] = [];
    const asked: { tool: string; detail: string }[] = [];
    const vendorIds: string[] = [];
    const started: (readonly string[])[] = [];
    const drafts: (readonly [string, string] | "end")[] = [];
    const deps: CodexDriverDeps = {
        session: async () => ({
            workdir: "/work",
            vendorSessionId: options.vendorSessionId ?? null,
            mode: options.mode === undefined ? "full" : options.mode
        }),
        help: async () => (options.help === undefined ? NEW_HELP : options.help),
        start: async (_id, argv) => {
            started.push(argv);
        },
        pipe: async () => pipe,
        storeRows: async (_id, stored) => {
            rows.push(...stored);
        },
        recordEvents: async (_id, recorded) => {
            events.push(...recorded);
        },
        recordVendorId: async (_id, id) => {
            vendorIds.push(id);
        },
        ask: async (_id, prompt) => {
            asked.push(prompt);
            return options.answer ?? "allow";
        },
        touch: () => undefined,
        drafts: () => ({ set: (id, text) => drafts.push([id, text]), end: () => drafts.push("end") }),
        log: () => undefined,
        pipeOptions: { minPollMs: 5, maxPollMs: 20 },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10)))
    };
    const driver = new CodexSessionDriver("session-1", deps);
    return { driver, pipe, rows, events, asked, vendorIds, started, drafts };
}

async function until(check: () => boolean, ms = 8_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const methods = (pipe: StdioPipe) => pipe.received().map((frame) => frame.method ?? null);

describe("Codex app-server: what is pure", () => {
    it("tells a Codex with app-server from one without", () => {
        expect(hasAppServer(NEW_HELP)).toBe(true);
        expect(hasAppServer(OLD_HELP)).toBe(false);
        expect(hasAppServer(null)).toBe(false);
    });

    it("turns an answer into one of the documented decisions", () => {
        expect(decisionFor("allow", undefined)).toBe("accept");
        expect(decisionFor("always", undefined)).toBe("acceptForSession");
        expect(decisionFor("always", ["accept", "decline", "cancel"])).toBe("accept");
        expect(decisionFor("deny", undefined)).toBe("decline");
        expect(decisionFor("pending", undefined)).toBe("cancel");
        expect(decisionFor("expired", undefined)).toBe("cancel");
        expect(decisionFor("allow", ["decline", "cancel"])).toBe("cancel");
    });

    it("offers Chat for Codex on a container or a server, not on a computer", () => {
        expect(usesAppServer("codex")).toBe(true);
        expect(usesAppServer("claude")).toBe(false);
        expect(chatAvailable("codex", "local")).toBe(true);
        expect(chatAvailable("codex", "host")).toBe(true);
        expect(chatAvailable("codex", "computer")).toBe(false);
        expect(usesAcp({ cli: "codex", place: "local", surface: "chat" })).toBe(true);
        expect(usesAcp({ cli: "codex", place: "local", surface: "terminal" })).toBe(false);
    });

    it("keeps full access as the terminal's own bypass", () => {
        expect(MODE_SETTINGS.full).toEqual({
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            sandboxPolicy: { type: "dangerFullAccess" }
        });
        expect(CODEX_APP_SERVER_ARGV).toEqual(["codex", "app-server"]);
    });

    it("keeps each item once, its message from the completed item", () => {
        const normalizer = new CodexNormalizer("thr", () => 1);
        const command = { type: "commandExecution", id: "c", command: "ls", status: "inProgress" };
        expect(normalizer.started(command).map((row) => row.vendorId)).toEqual(["thr:c:call"]);
        const done = normalizer.completed({ ...command, status: "failed", exitCode: 2, aggregatedOutput: "no" });
        expect(done).toEqual([
            { vendorId: "thr:c:result", role: "agent", kind: "result", subject: "error", ref: "c", body: "no", at: 1 }
        ]);
        expect(normalizer.completed({ ...command, status: "failed" })).toEqual([]);
        expect(normalizer.started({ type: "reasoning", id: "r", summary: [], content: [] })).toEqual([]);
        expect(normalizer.completed({ type: "contextCompaction", id: "k" })[0]).toMatchObject({ subject: "compacted" });
        expect(normalizer.completed({ type: "agentMessage", id: "m", text: "  hi " })[0]).toMatchObject({
            role: "agent",
            kind: "text",
            body: "hi"
        });
        expect(normalizer.finish("interrupted", "t")[0]).toMatchObject({ kind: "marker", subject: "interrupted" });
        expect(normalizer.finish("completed", "t")).toEqual([]);
    });
});

describe("CodexSessionDriver against a fake app-server on stdio", () => {
    it("starts a thread, asks before a command, and records the turn as history", async () => {
        const { driver, pipe, rows, events, asked, vendorIds, started } = harness();
        await driver.prompt("run tests");
        await until(() => !driver.busy);
        await driver.settled();

        expect(started).toEqual([["codex", "app-server"]]);
        expect(vendorIds).toEqual(["thr_123"]);
        const sent = pipe.received();
        expect(methods(pipe).slice(0, 4)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
        expect(sent[0]!.params).toEqual({ clientInfo: { name: "polaris", title: "Polaris", version: "1" } });
        expect(sent[2]!.params).toEqual({ cwd: "/work", approvalPolicy: "never", sandbox: "danger-full-access" });
        expect(sent[3]!.params).toEqual({
            threadId: "thr_123",
            input: [{ type: "text", text: "run tests" }],
            approvalPolicy: "never",
            sandboxPolicy: { type: "dangerFullAccess" }
        });
        // The request Polaris does not model was answered, with an error.
        expect(sent).toContainEqual({
            answered: "item/tool/requestUserInput",
            reply: { id: "srv-1", error: { code: -32601, message: "Polaris does not answer this request." } }
        });
        expect(sent).toContainEqual({ id: "srv-2", result: { decision: "accept" } });
        expect(asked).toEqual([{ tool: "shell", detail: "npm test\nRun the test suite" }]);

        expect(rows.map((row) => [row.role, row.kind, row.subject, row.body])).toEqual([
            ["user", "text", "", "run tests"],
            ["agent", "tool", "shell", "npm test"],
            ["agent", "result", "", "42 passed"],
            ["agent", "text", "", "All done."]
        ]);
        expect(events.map((event) => event.kind)).toEqual(["prompt", "permission", "tool.start", "turn.end"]);
        driver.close();
    });

    it("draws the answer as its deltas arrive and ends the draft once the item is whole", async () => {
        const { driver, drafts } = harness();
        await driver.prompt("run tests");
        await until(() => !driver.busy);
        await driver.settled();
        const grown = drafts.filter((call) => call !== "end");
        expect(grown.map((call) => call[1])).toEqual(["All ", "All done."]);
        expect(new Set(grown.map((call) => call[0])).size).toBe(1);
        // Ended when the item completed, before the turn did.
        expect(drafts.indexOf("end")).toBe(grown.length);
        expect(drafts.at(-1)).toBe("end");
        driver.close();
    });

    it("declines a command the person denied", async () => {
        const { driver, pipe, rows, events } = harness({ answer: "deny" });
        await driver.prompt("run tests");
        await until(() => !driver.busy);
        await driver.settled();
        expect(pipe.received()).toContainEqual({ id: "srv-2", result: { decision: "decline" } });
        expect(rows.find((row) => row.kind === "result")).toMatchObject({ subject: "error" });
        expect(events.map((event) => event.kind)).toEqual(["prompt", "permission", "turn.end"]);
        driver.close();
    });

    it("reopens the stored thread instead of starting one", async () => {
        const { driver, pipe } = harness({ vendorSessionId: "thr_123" });
        await driver.prompt("hello");
        await until(() => !driver.busy);
        expect(methods(pipe).slice(0, 4)).toEqual(["initialize", "initialized", "thread/resume", "turn/start"]);
        expect(pipe.received()[2]!.params).toEqual({ threadId: "thr_123", excludeTurns: true });
        driver.close();
    });

    it("starts a new thread when the stored one cannot be reopened", async () => {
        const { driver, pipe, vendorIds } = harness({ vendorSessionId: "thr_gone" });
        await driver.prompt("hello");
        await until(() => !driver.busy);
        expect(methods(pipe).slice(0, 5)).toEqual([
            "initialize",
            "initialized",
            "thread/resume",
            "thread/start",
            "turn/start"
        ]);
        expect(vendorIds).toEqual(["thr_123"]);
        driver.close();
    });

    it("interrupts the running turn and marks it as stopped", async () => {
        const { driver, pipe, rows, events } = harness();
        await driver.prompt("hold");
        await until(() => rows.some((row) => row.role === "user"));
        await driver.cancel();
        await until(() => !driver.busy);
        await driver.settled();
        const interrupt = pipe.received().find((frame) => frame.method === "turn/interrupt");
        expect(interrupt?.params).toEqual({ threadId: "thr_123", turnId: "turn_1" });
        expect(rows.at(-1)).toMatchObject({ kind: "marker", subject: "interrupted" });
        expect(events.at(-1)?.kind).toBe("turn.end");
        driver.close();
    });

    it("reports a failed turn in Polaris's words", async () => {
        const { driver, events } = harness();
        await driver.prompt("break");
        await until(() => !driver.busy);
        await driver.settled();
        expect(events.at(-1)).toEqual({ kind: "turn.failed", detail: "The agent stopped before it answered.", subject: "" });
        driver.close();
    });

    it("refuses a second message while a turn runs", async () => {
        const { driver } = harness();
        await driver.prompt("hold");
        await expect(driver.prompt("again")).rejects.toThrow(/still on the last message/);
        await driver.cancel().catch(() => undefined);
        driver.close();
    });

    it("puts a mode picked mid-session on the next turn", async () => {
        const { driver, pipe } = harness({ mode: "full" });
        await driver.setMode("ask");
        await driver.prompt("hello");
        await until(() => !driver.busy);
        const turn = pipe.received().find((frame) => frame.method === "turn/start");
        expect(turn?.params).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } });
        const thread = pipe.received().find((frame) => frame.method === "thread/start");
        expect(thread?.params).toMatchObject({ approvalPolicy: "on-request", sandbox: "read-only" });
        driver.close();
    });

    it("starts nothing on a Codex without app-server, so the session goes back to its terminal", async () => {
        const { driver, started } = harness({ help: OLD_HELP });
        await expect(driver.prompt("hello")).rejects.toBeInstanceOf(CodexAppServerMissing);
        expect(started).toEqual([]);
        const unreadable = harness({ help: null });
        await expect(unreadable.driver.prompt("hello")).rejects.toBeInstanceOf(CodexAppServerMissing);
    });
});

vi.setConfig({ testTimeout: 20_000 });
