import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

const settings = new Map<string, string>();
const said = new Map<string, string>();
const asked: string[] = [];
const hosts = new Map<string, { id: string }>();

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => {
        settings.set(key, value);
    }
}));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.test/" }));
vi.mock("@/lib/host-service", () => ({
    getHostConnectionUnscoped: async (id: string) => {
        if (said.get(id) === "ssh-down") throw new Error("connect ECONNREFUSED");
        return { address: id, port: 22, username: "u", auth: {}, hostKey: "k" };
    }
}));
vi.mock("@/lib/connection-pool", () => ({
    borrowSsh: async (_purpose: string, id: string) => ({ client: { id }, release: () => undefined })
}));
vi.mock("@polaris/ssh", () => ({
    execCommand: async (client: { id: string }, _script: string, options: { onStdout: (chunk: Buffer) => void }) => {
        asked.push(client.id);
        options.onStdout(Buffer.from(said.get(client.id) ?? "200"));
        return { code: 0 };
    }
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        host: { findMany: async () => [...hosts.values()] },
        agentSession: { groupBy: async () => [] }
    }
}));

const reach = await import("@/lib/agents/pool-reach");
const state = await import("@/lib/agents/pool-reach-state");
const placement = await import("@/lib/agents/session-placement");

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

describe("whether a pool server reaches Polaris", () => {
    beforeEach(() => {
        settings.clear();
        said.clear();
        asked.length = 0;
        hosts.clear();
    });

    it("reads what the server printed", () => {
        expect(reach.readReachOutput("200")).toBe("ok");
        expect(reach.readReachOutput("503\n")).toBe("ok");
        expect(reach.readReachOutput("000")).toBe("blocked");
        expect(reach.readReachOutput("404")).toBe("blocked");
        expect(reach.readReachOutput("none")).toBe("noTool");
    });

    it("asks the health check at the address sessions report to", async () => {
        said.set(A, "000");
        said.set(B, "ssh-down");
        const answer = await reach.checkReach(A, [A]);
        expect(answer).toMatchObject({ state: "blocked", url: "https://polaris.example.test" });
        expect((await reach.probeReach(B)).state).toBe("down");
        expect(Object.keys(await state.readReach())).toEqual([A]);
    });

    it("asks the oldest answers first, a few a run, and forgets servers that left the pool", async () => {
        settings.set(
            state.REACH_KEY,
            JSON.stringify({
                [A]: { state: "ok", at: 1_000, url: "x" },
                [B]: { state: "ok", at: 1_000_000, url: "x" },
                [C]: { state: "ok", at: 1, url: "x" }
            })
        );
        const now = 1_000_000 + 60_000;
        expect(await reach.recheckReach([A, B], now)).toBe(1);
        expect(asked).toEqual([A]);
        const kept = await state.readReach();
        expect(Object.keys(kept).sort()).toEqual([A, B]);
        expect(kept[A]!.at).toBe(now);
    });

    it("keeps a server that cannot reach Polaris out of placement, for a while", async () => {
        hosts.set(A, { id: A });
        hosts.set(B, { id: B });
        const now = Date.now();
        settings.set(state.REACH_KEY, JSON.stringify({ [A]: { state: "blocked", at: now, url: "x" } }));
        const pool = { box: false, servers: [{ hostId: A, sessions: 4 }, { hostId: B, sessions: 4 }] };
        expect((await placement.poolCandidates(pool, 4)).map((one) => one.hostId)).toEqual([B]);
        expect(state.reachBlocked({ state: "blocked", at: now - state.BLOCKED_HOLDS_MS - 1, url: "x" }, now)).toBe(false);
        expect(state.reachBlocked({ state: "noTool", at: now, url: "x" }, now)).toBe(false);
    });

    it.runIf(process.platform !== "win32")("runs with curl, with wget, and says when it has neither", () => {
        const dir = mkdtempSync(join(tmpdir(), "reach-"));
        try {
            const run = (tools: Record<string, string>) => {
                for (const [name, body] of Object.entries(tools)) {
                    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
                    chmodSync(join(dir, name), 0o755);
                }
                const result = spawnSync("/bin/sh", ["-c", reach.reachScript("https://polaris.test/api/health")], {
                    env: { PATH: dir },
                    encoding: "utf8"
                });
                for (const name of Object.keys(tools)) rmSync(join(dir, name));
                return result.stdout.trim();
            };
            expect(run({ curl: "printf 200" })).toBe("200");
            expect(run({ wget: "exit 8" })).toBe("503");
            expect(run({ wget: "exit 4" })).toBe("000");
            expect(run({})).toBe("none");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
