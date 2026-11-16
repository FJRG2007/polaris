import { join } from "node:path";
import { readFileSync } from "node:fs";
import { FakePipe, noSleep } from "./fake-pipe";
import { describe, expect, it, vi } from "vitest";
import * as core from "@polaris/core";
import { acpLaunchCommand } from "@/lib/agents/acp/pipe-commands";
import type { HistoryRow } from "@/lib/agents/transcript-decoders";
import { AcpRefusal, AcpSessionDriver, meetsFloor, TOO_OLD, type DriverDeps } from "@/lib/agents/acp/session-driver";
import {
    acpBinding,
    acpModeFor,
    chatAvailable,
    CLAUDE_ACP_ADAPTER,
    readSurface,
    usesAcp
} from "@/lib/agents/acp/providers";

type Frame = Record<string, unknown>;

const AGENTS = [
    "claude",
    "gemini",
    "qwen",
    "kimi",
    "cursor",
    "droid",
    "grok",
    "opencode",
    "omp",
    "kimchi",
    "hermes",
    "command-code",
    "deepseek-harness",
    "copilot",
    "agy"
] as const;

function recorded(cli: string): Frame[] {
    return readFileSync(join(__dirname, "fixtures", "agents", `${cli}.jsonl`), "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Frame);
}

/** The agent's side of its recorded conversation, answering the ids the
 *  driver actually used. */
function agentFor(cli: string, options: { failPrompt?: boolean; holdPrompt?: boolean } = {}) {
    const frames = recorded(cli);
    const sessionId = (frames[1]!.result as { sessionId: string }).sessionId;
    let promptId: unknown = null;
    return (frame: Frame, pipe: FakePipe): void => {
        const answer = (result: unknown) => pipe.emit({ jsonrpc: "2.0", id: frame.id, result });
        switch (frame.method) {
            case "initialize":
                return answer(frames[0]!.result);
            case "session/new":
                return answer(frames[1]!.result);
            case "session/load":
                // A replay of the old conversation, then the answer.
                pipe.emit(frames[2]!);
                return answer({ modes: (frames[1]!.result as Frame).modes ?? null });
            case "session/set_mode":
                return answer({});
            case "session/cancel":
                if (promptId !== null)
                    pipe.emit({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
                return;
            case "session/prompt":
                promptId = frame.id;
                if (options.failPrompt)
                    return pipe.emit({ jsonrpc: "2.0", id: frame.id, error: { code: -32603, message: "boom /home/x" } });
                if (options.holdPrompt) return;
                for (const recordedFrame of frames.slice(2, 6)) pipe.emit(recordedFrame);
                return;
        }
        if (frame.id === 7 && "result" in frame) {
            pipe.emit(frames[6]!);
            pipe.emit(frames[7]!);
            pipe.emit({ ...frames[8]!, id: promptId });
        }
        void sessionId;
    };
}

function harness(cli: string, pipe: FakePipe, vendorSessionId: string | null = null) {
    const rows: HistoryRow[] = [];
    const events: string[] = [];
    const vendorIds: string[] = [];
    const starts: (readonly string[])[] = [];
    const binding = acpBinding(cli)!;
    const deps: DriverDeps = {
        session: async () => ({ binding, workdir: "/work/repo", vendorSessionId }),
        // Above every binding's floor.
        version: async () => "99.0.0",
        start: async (_id, argv) => {
            starts.push(argv);
        },
        pipe: async () => pipe,
        storeRows: async (_id, stored) => {
            rows.push(...stored);
        },
        recordEvents: async (_id, recordedEvents) => {
            events.push(...recordedEvents.map((event) => event.kind));
        },
        recordVendorId: async (_id, id) => {
            vendorIds.push(id);
        },
        permission: () => async (request) => request.options.find((option) => option.kind === "allow_once")?.optionId ?? null,
        touch: () => undefined,
        log: () => undefined,
        pipeOptions: { sleep: noSleep, minPollMs: 0, maxPollMs: 0 },
        sleep: noSleep
    };
    return { driver: new AcpSessionDriver("session-1", deps), rows, events, vendorIds, starts };
}

describe("ACP provider bindings", () => {
    it("starts each agent with its documented ACP entry point", () => {
        expect(acpBinding("gemini")?.argv).toEqual(["gemini", "--acp"]);
        expect(acpBinding("qwen")?.argv).toEqual(["qwen", "--acp"]);
        expect(acpBinding("qwen")?.minVersion).toBe("0.16.0");
        expect(acpBinding("kimi")?.argv).toEqual(["kimi", "acp"]);
        expect(acpBinding("cursor")?.argv).toEqual(["cursor-agent", "acp"]);
        expect(acpBinding("droid")?.argv).toEqual(["droid", "exec", "--output-format", "acp"]);
        expect(acpBinding("grok")?.argv).toEqual(["grok", "agent", "stdio"]);
        expect(acpBinding("opencode")?.argv).toEqual(["opencode", "acp"]);
        expect(acpBinding("omp")?.argv).toEqual(["omp", "acp"]);
        expect(acpBinding("omp")?.minVersion).toBe("15.0.0");
        expect(acpBinding("kimchi")?.argv).toEqual(["kimchi", "--mode", "acp"]);
        expect(acpBinding("kimchi")?.minVersion).toBe("0.0.7");
        expect(acpBinding("hermes")?.argv).toEqual(["hermes", "acp"]);
        expect(acpBinding("command-code")?.argv).toEqual(["command-code", "acp"]);
        expect(acpBinding("deepseek-harness")?.argv).toEqual(["dsh", "--profile", "acp"]);
        expect(acpBinding("copilot")?.argv).toEqual(["copilot", "--acp"]);
        expect(acpBinding("agy")?.argv).toEqual(["agy", "acp"]);
        const claude = acpBinding("claude")!.argv;
        expect(claude.slice(0, 2)).toEqual(["sh", "-c"]);
        expect(claude[2]).toContain(`exec npx -y ${CLAUDE_ACP_ADAPTER}`);
        expect(claude[2]).toContain("CLAUDE_CODE_EXECUTABLE");
    });

    it("pins the Claude adapter to an exact version", () => {
        expect(CLAUDE_ACP_ADAPTER).toMatch(/^@agentclientprotocol\/claude-agent-acp@\d+\.\d+\.\d+$/);
    });

    it("gives every launch line one the pipe accepts", () => {
        for (const cli of AGENTS) expect(() => acpLaunchCommand("/state", acpBinding(cli)!.argv)).not.toThrow();
    });

    it("starts each one with a binary its catalogue entry names", () => {
        for (const cli of AGENTS) {
            if (cli === "claude") continue;
            expect(core.agentCliById(cli)?.binaries).toContain(acpBinding(cli)!.argv[0]);
        }
    });

    it("has no binding for an agent not covered yet", () => {
        expect(acpBinding("codex")).toBeNull();
        // Pi has no ACP mode of its own, only third-party adapters.
        expect(acpBinding("pi")).toBeNull();
        expect(chatAvailable("codex", "local")).toBe(false);
    });

    it("keeps Chat off a computer's runner and off every session by default", () => {
        expect(chatAvailable("claude", "computer")).toBe(false);
        expect(chatAvailable("claude", "host")).toBe(true);
        expect(readSurface(null)).toBe("terminal");
        expect(readSurface("anything")).toBe("terminal");
        expect(usesAcp({ cli: "claude", place: "local", surface: "terminal" })).toBe(false);
        expect(usesAcp({ cli: "claude", place: "local", surface: "chat" })).toBe(true);
    });

    it("sends only a mode the agent offered", () => {
        const claude = acpBinding("claude")!;
        expect(acpModeFor(claude, "edits", [{ id: "default" }, { id: "acceptEdits" }])).toBe("acceptEdits");
        expect(acpModeFor(claude, "full", [{ id: "default" }])).toBeNull();
        expect(acpModeFor(acpBinding("gemini")!, "plan", [{ id: "plan" }])).toBeNull();
        expect(acpModeFor(acpBinding("cursor")!, "plan", [{ id: "agent" }, { id: "plan" }])).toBe("plan");
        const commandCode = acpBinding("command-code")!;
        const offered = (recorded("command-code")[1]!.result as { modes: { availableModes: { id: string }[] } }).modes
            .availableModes;
        expect(acpModeFor(commandCode, "ask", offered)).toBe("default");
        expect(acpModeFor(commandCode, "edits", offered)).toBe("auto-accept");
        expect(acpModeFor(commandCode, "plan", offered)).toBe("plan");
        expect(acpModeFor(commandCode, "full", offered)).toBe("bypass");
        const kimchi = acpBinding("kimchi")!;
        const kimchiModes = [{ id: "default" }, { id: "plan" }, { id: "auto" }, { id: "yolo" }];
        expect(acpModeFor(kimchi, "full", kimchiModes)).toBe("yolo");
        expect(acpModeFor(kimchi, "edits", kimchiModes)).toBeNull();
    });
});

describe.each(AGENTS)("recorded %s conversation through the driver", (cli) => {
    it("starts the agent, opens a session, stores the turn and reports it", async () => {
        const pipe = new FakePipe(agentFor(cli));
        const { driver, rows, events, vendorIds, starts } = harness(cli, pipe);
        await driver.prompt("Run the tests");
        await driver.settled();
        expect(starts).toEqual([acpBinding(cli)!.argv]);
        const sessionId = (recorded(cli)[1]!.result as { sessionId: string }).sessionId;
        expect(vendorIds).toEqual([sessionId]);
        expect(pipe.received.find((frame) => frame.method === "session/new")?.params).toMatchObject({ cwd: "/work/repo" });
        expect(rows.map((row) => [row.role, row.kind, row.body])).toEqual([
            ["agent", "text", "Looking at the tests."],
            ["agent", "tool", expect.stringContaining("npm test")],
            ["agent", "result", "12 passed"],
            ["agent", "text", "All green."]
        ]);
        expect(events).toEqual(["prompt", "permission", "tool.start", "turn.end"]);
        expect(driver.busy).toBe(false);
        driver.close();
    });
});

describe("AcpSessionDriver", () => {
    it("reopens a stored conversation without storing its replay", async () => {
        const pipe = new FakePipe(agentFor("claude"));
        const { driver, rows, vendorIds } = harness("claude", pipe, "sess-claude-01");
        await driver.prompt("Again");
        await driver.settled();
        expect(pipe.received.some((frame) => frame.method === "session/new")).toBe(false);
        expect(pipe.received.find((frame) => frame.method === "session/load")?.params).toMatchObject({
            sessionId: "sess-claude-01"
        });
        expect(vendorIds).toEqual(["sess-claude-01"]);
        // The replayed "Looking at " chunk is not a row of its own.
        expect(rows.filter((row) => row.kind === "text").map((row) => row.body)).toEqual([
            "Looking at the tests.",
            "All green."
        ]);
        driver.close();
    });

    it("changes mode to the offered id", async () => {
        const pipe = new FakePipe(agentFor("claude"));
        const { driver } = harness("claude", pipe);
        await driver.setMode("plan");
        expect(pipe.received.find((frame) => frame.method === "session/set_mode")?.params).toMatchObject({
            sessionId: "sess-claude-01",
            modeId: "plan"
        });
        await expect(driver.setMode("full")).resolves.toBeUndefined();
        driver.close();
    });

    it("refuses a mode the agent does not have", async () => {
        const pipe = new FakePipe(agentFor("gemini"));
        const { driver } = harness("gemini", pipe);
        await expect(driver.setMode("plan")).rejects.toBeInstanceOf(AcpRefusal);
        driver.close();
    });

    it("refuses a second message mid-turn, and a cancel ends the turn as interrupted", async () => {
        const pipe = new FakePipe(agentFor("cursor", { holdPrompt: true }));
        const { driver, rows, events } = harness("cursor", pipe);
        await driver.prompt("Long job");
        await expect(driver.prompt("Another")).rejects.toBeInstanceOf(AcpRefusal);
        await vi.waitFor(() => expect(pipe.received.some((frame) => frame.method === "session/prompt")).toBe(true));
        await driver.cancel();
        await vi.waitFor(() => expect(driver.busy).toBe(false));
        await driver.settled();
        expect(rows.at(-1)).toMatchObject({ role: "system", kind: "marker", subject: "interrupted" });
        expect(events).toEqual(["prompt", "turn.end"]);
        driver.close();
    });

    it("reports a rejected turn as failed, in its own words rather than the agent's", async () => {
        const pipe = new FakePipe(agentFor("qwen", { failPrompt: true }));
        const recordedEvents: { kind: string; detail: string }[] = [];
        const { driver } = harness("qwen", pipe);
        (driver as unknown as { deps: DriverDeps }).deps.recordEvents = async (_id, list) => {
            recordedEvents.push(...list);
        };
        await driver.prompt("x");
        await driver.settled();
        expect(recordedEvents.at(-1)).toEqual({
            kind: "turn.failed",
            detail: "The agent stopped before it answered.",
            subject: ""
        });
        driver.close();
    });

    it("restarts the agent after the connection ended", async () => {
        const pipe = new FakePipe(agentFor("kimi"));
        const { driver, starts } = harness("kimi", pipe);
        await driver.prompt("one");
        await driver.settled();
        // The agent exits: the pipe reports it, and the connection ends.
        pipe.exitCode = 0;
        await vi.waitFor(async () => {
            await expect(driver.prompt("two").then(() => "sent", () => "refused")).resolves.toBe("refused");
        });
        pipe.exitCode = null;
        pipe.generation = "1700000000000000001-43";
        await driver.prompt("three");
        await driver.settled();
        expect(starts.length).toBeGreaterThanOrEqual(2);
        driver.close();
    });

    it("gives up on an agent that never appears on its pipe", async () => {
        const pipe = new FakePipe(agentFor("gemini"));
        pipe.running = false;
        const { driver } = harness("gemini", pipe);
        (driver as unknown as { deps: DriverDeps }).deps.startWaitMs = 0;
        await expect(driver.prompt("x")).rejects.toThrow("The agent did not start in time.");
    });
});

describe("an agent's version floor", () => {
    it("compares the first version on the line, and lets an unreadable one through", () => {
        expect(meetsFloor("0.16.0", "0.16.0")).toBe(true);
        expect(meetsFloor("qwen 0.17.1 (build x)", "0.16.0")).toBe(true);
        expect(meetsFloor("1.0.0", "0.16.0")).toBe(true);
        expect(meetsFloor("0.15.9", "0.16.0")).toBe(false);
        expect(meetsFloor("0.9.40", "0.16.0")).toBe(false);
        expect(meetsFloor("", "0.16.0")).toBe(true);
        expect(meetsFloor(null, "0.16.0")).toBe(true);
    });

    it("refuses Chat on a Qwen older than 0.16 before starting anything", async () => {
        const pipe = new FakePipe(agentFor("qwen"));
        const { driver, starts } = harness("qwen", pipe);
        const versions: string[] = [];
        (driver as unknown as { deps: DriverDeps }).deps.version = async (_id, binary) => {
            versions.push(binary);
            return "0.15.3";
        };
        await expect(driver.prompt("x")).rejects.toThrow(AcpRefusal);
        await expect(driver.prompt("x")).rejects.toThrow(TOO_OLD);
        expect(versions[0]).toBe("qwen");
        expect(starts).toHaveLength(0);
    });

    it("never asks an agent with no floor for its version", async () => {
        const pipe = new FakePipe(agentFor("gemini"));
        const { driver } = harness("gemini", pipe);
        let asked = false;
        (driver as unknown as { deps: DriverDeps }).deps.version = async () => {
            asked = true;
            return null;
        };
        await driver.prompt("hi");
        await driver.settled();
        expect(asked).toBe(false);
        driver.close();
    });
});

describe("frames captured from the real agents", () => {
    it("carries on past the Claude adapter's own sign-in notice after initialize", async () => {
        // Sent by @agentclientprotocol/claude-agent-acp 0.99.1 right after its
        // initialize answer, captured with no account signed in.
        const notice = {
            jsonrpc: "2.0",
            method: "_auth/status_update",
            params: { authStatus: { kind: "none", label: "Not logged in" } }
        };
        const inner = agentFor("claude");
        const pipe = new FakePipe((frame, fake) => {
            inner(frame, fake);
            if (frame.method === "initialize") fake.emit(notice);
        });
        const { driver, events } = harness("claude", pipe);
        await driver.prompt("hi");
        await driver.settled();
        expect(events).toContain("turn.end");
        driver.close();
    });

    it("reads each captured initialize answer as an agent that can reopen a conversation", () => {
        for (const cli of ["claude", "gemini", "qwen", "command-code", "droid", "opencode", "copilot"]) {
            const init = recorded(cli)[0]!.result as { agentCapabilities?: { loadSession?: boolean }; agentInfo?: { version?: string } };
            expect(init.agentCapabilities?.loadSession).toBe(true);
            expect(init.agentInfo?.version).not.toContain("fixture");
        }
    });
});
