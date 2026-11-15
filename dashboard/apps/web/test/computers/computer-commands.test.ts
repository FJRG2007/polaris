/**
 * Commands reach a runner whichever node holds its socket: straight to the
 * sidecar here, inline over NOTIFY elsewhere, parked when too large, and a
 * notice for another node or an invalid command never acts.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/live/pg-listener", () => ({
    NOTIFY_PAYLOAD_LIMIT: 8000,
    pgListener: () => ({ listen: () => () => undefined })
}));

const { createRunnerCommands, readCommand, splitBase64 } = await import("@/lib/computers/computer-commands");

const RUNNER = "0190f5d2-6a3b-7c4d-8e5f-0a1b2c3d4e5f";
const SESSION = "0190f5d2-6a3b-7c4d-8e5f-0a1b2c3d4e60";

type Parked = Map<string, { runnerId: string; body: string }>;

function fakeDeps(node: string, where: string | null, parked: Parked = new Map()) {
    const notices: string[] = [];
    const local: Array<{ runnerId: string; command: unknown }> = [];
    return {
        notices,
        parked,
        local,
        deps: {
            node: () => node,
            locate: async () => where,
            notify: async (payload: string) => void notices.push(payload),
            park: async (runnerId: string, body: string) => {
                const id = `0190f5d2-6a3b-7c4d-8e5f-00000000000${parked.size}`;
                parked.set(id, { runnerId, body });
                return id;
            },
            collect: async (id: string) => {
                const row = parked.get(id) ?? null;
                parked.delete(id);
                return row;
            },
            local: async (runnerId: string, command: unknown) => {
                local.push({ runnerId, command });
                return true;
            }
        }
    };
}

describe("createRunnerCommands", () => {
    it("hands a command to this node's sidecar when it holds the runner", async () => {
        const fake = fakeDeps("a", "a");
        const commands = createRunnerCommands(fake.deps);
        expect(await commands.send(RUNNER, { type: "interrupt", sessionId: SESSION })).toBe(true);
        expect(fake.local).toEqual([{ runnerId: RUNNER, command: { type: "interrupt", sessionId: SESSION } }]);
        expect(fake.notices).toEqual([]);
    });

    it("refuses a runner connected nowhere", async () => {
        const fake = fakeDeps("a", null);
        expect(await createRunnerCommands(fake.deps).send(RUNNER, { type: "close" })).toBe(false);
        expect(fake.local).toEqual([]);
    });

    it("notifies inline for another node, which delivers it", async () => {
        const sender = fakeDeps("a", "b");
        await createRunnerCommands(sender.deps).send(RUNNER, { type: "interrupt", sessionId: SESSION });
        expect(sender.notices).toHaveLength(1);
        const receiver = fakeDeps("b", "b");
        await createRunnerCommands(receiver.deps).receive(sender.notices[0]!);
        expect(receiver.local).toEqual([{ runnerId: RUNNER, command: { type: "interrupt", sessionId: SESSION } }]);
    });

    it("parks a command too large for a NOTIFY, collected once", async () => {
        const sender = fakeDeps("a", "b");
        const text = "x".repeat(20_000);
        await createRunnerCommands(sender.deps).send(RUNNER, { type: "prompt", sessionId: SESSION, text });
        expect(sender.parked.size).toBe(1);
        expect(sender.notices[0]!.length).toBeLessThan(8000);
        const receiver = fakeDeps("b", "b", sender.parked);
        const commands = createRunnerCommands(receiver.deps);
        await commands.receive(sender.notices[0]!);
        await commands.receive(sender.notices[0]!);
        expect(receiver.local).toHaveLength(1);
        expect((receiver.local[0]!.command as { text: string }).text).toBe(text);
    });

    it("ignores a notice naming another node", async () => {
        const sender = fakeDeps("a", "b");
        await createRunnerCommands(sender.deps).send(RUNNER, { type: "interrupt", sessionId: SESSION });
        const other = fakeDeps("c", "c");
        await createRunnerCommands(other.deps).receive(sender.notices[0]!);
        expect(other.local).toEqual([]);
    });

    it("drops an invalid command and garbage", async () => {
        const node = fakeDeps("b", "b");
        const commands = createRunnerCommands(node.deps);
        await commands.receive(JSON.stringify({ r: RUNNER, n: "b", m: { type: "prompt", sessionId: SESSION, text: "" } }));
        await commands.receive(JSON.stringify({ r: RUNNER, n: "b", m: { type: "welcome" } }));
        await commands.receive("not json");
        expect(node.local).toEqual([]);
    });
});

describe("readCommand", () => {
    it("reads close, watch and relayed frames, and refuses the relay's own", () => {
        expect(readCommand({ type: "close" })).toEqual({ type: "close" });
        expect(readCommand({ type: "watch", sessionId: SESSION, node: "b" })).toEqual({
            type: "watch",
            sessionId: SESSION,
            node: "b"
        });
        expect(readCommand({ type: "watch", sessionId: "nope", node: "b" })).toBeNull();
        expect(readCommand({ type: "heartbeat.ack" })).toBeNull();
        expect(readCommand(null)).toBeNull();
    });
});

describe("splitBase64", () => {
    it("splits into pieces that each decode and rejoin to the whole", () => {
        const text = "a".repeat(1000);
        const pieces = splitBase64(Buffer.from(text).toString("base64"), 102);
        expect(pieces.length).toBeGreaterThan(1);
        expect(pieces.slice(0, -1).every((piece) => piece.length === 100)).toBe(true);
        expect(Buffer.concat(pieces.map((piece) => Buffer.from(piece, "base64"))).toString()).toBe(text);
    });
});
