/**
 * The Polaris Terminal remote-control relay: the sidecar's socket rules
 * (`terminal-relay.mjs`) with fake sockets, and the cross-node framing
 * (`lib/terminal/relay.ts`) as pure functions.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/api-key-auth", () => ({ authenticateKeyToken: async () => null }));

import { createCallAssembler, encodeRemoteCall } from "../../src/lib/terminal/relay";
import { TERMINAL_CLOSE, TERMINAL_LIMITS, createTerminalRelay } from "../../terminal-relay.mjs";

const INSTANCE = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const USER = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a50";
const KEY = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51";

class FakeSocket {
    bufferedAmount = 0;
    sent: Record<string, unknown>[] = [];
    closed: { code: number; reason: string } | null = null;
    send(data: string) {
        this.sent.push(JSON.parse(data));
    }
    close(code: number, reason: string) {
        this.closed = { code, reason };
    }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(route: { allowed: boolean; node: string | null } = { allowed: true, node: "a" }) {
    let at = 1_000;
    const calls: Record<string, unknown>[] = [];
    const app = vi.fn(async (body: Record<string, unknown>) => {
        calls.push(body);
        if (body.op === "auth")
            return body.token === "good"
                ? { userId: USER, keyId: KEY, ...(body.role === "instance" ? { instanceId: INSTANCE } : {}) }
                : null;
        if (body.op === "route") return route;
        return { ok: true };
    });
    const relay = createTerminalRelay({ app, node: "a", now: () => at, log: () => {} });
    return { relay, app, calls, advance: (ms: number) => (at += ms) };
}

async function connect(relay: ReturnType<typeof createTerminalRelay>, role: string, token = "good") {
    const socket = new FakeSocket();
    const handlers = relay.accept(socket, { role, token });
    await flush();
    return { socket, handlers };
}

describe("terminal relay sockets", () => {
    it("refuses a socket whose key does not check out", async () => {
        const { relay } = setup();
        const { socket } = await connect(relay, "instance", "bad");
        expect(socket.closed?.code).toBe(TERMINAL_CLOSE.unauthorized);
    });

    it("refuses an unknown role without asking about the key", async () => {
        const { relay, app } = setup();
        const { socket } = await connect(relay, "viewer");
        expect(socket.closed?.code).toBe(TERMINAL_CLOSE.protocol);
        expect(app).not.toHaveBeenCalled();
    });

    it("routes a controller's envelope to the instance and its answer back, unchanged", async () => {
        const { relay, calls } = setup();
        const instance = await connect(relay, "instance");
        instance.handlers.message(JSON.stringify({ type: "hello", name: "laptop", os: "linux", version: "1.0.0" }));
        await flush();
        expect(instance.socket.sent[0]).toEqual({ type: "ready", instance: INSTANCE });
        expect(calls.find((c) => c.op === "presence")).toMatchObject({ online: true, name: "laptop", node: "a" });

        const controller = await connect(relay, "controller");
        const envelope = { protocol_version: 1, request_id: "r1", target: {}, action: { type: "tab.list" } };
        controller.handlers.message(JSON.stringify({ type: "request", instance: INSTANCE, envelope }));
        await flush();
        const forwarded = instance.socket.sent[1] as { type: string; id: string; envelope: unknown };
        expect(forwarded.type).toBe("request");
        expect(forwarded.envelope).toEqual(envelope);
        expect(calls.find((c) => c.op === "route")).toMatchObject({ userId: USER, keyId: KEY, instanceId: INSTANCE });

        const response = { request_id: "r1", result: { tabs: [] } };
        instance.handlers.message(JSON.stringify({ type: "response", id: forwarded.id, envelope: response }));
        await flush();
        expect(controller.socket.sent).toEqual([
            { type: "response", instance: INSTANCE, request_id: "r1", envelope: response }
        ]);
    });

    it("answers not_found for an instance the caller may not reach", async () => {
        const { relay } = setup({ allowed: false, node: null });
        const controller = await connect(relay, "controller");
        controller.handlers.message(
            JSON.stringify({ type: "request", instance: INSTANCE, envelope: { request_id: "x" } })
        );
        await flush();
        expect(controller.socket.sent).toEqual([
            { type: "error", instance: INSTANCE, code: "not_found", request_id: "x" }
        ]);
    });

    it("answers offline when the instance is not connected", async () => {
        const { relay } = setup({ allowed: true, node: null });
        const controller = await connect(relay, "controller");
        controller.handlers.message(JSON.stringify({ type: "request", instance: INSTANCE, envelope: {} }));
        await flush();
        expect(controller.socket.sent).toEqual([{ type: "error", instance: INSTANCE, code: "offline" }]);
    });

    it("sends a request for an instance on another node through the web app", async () => {
        const { relay, calls } = setup({ allowed: true, node: "b" });
        const controller = await connect(relay, "controller");
        controller.handlers.message(JSON.stringify({ type: "request", instance: INSTANCE, envelope: { a: 1 } }));
        await flush();
        const forward = calls.find((c) => c.op === "forward") as { id: string };
        expect(forward).toMatchObject({ node: "b", origin: "a", instanceId: INSTANCE, envelope: { a: 1 } });

        // The other node's answer arrives on the loopback route.
        relay.internal("/terminal/reply", { id: forward.id, frame: { type: "response", envelope: { ok: true } } });
        expect(controller.socket.sent).toEqual([{ type: "response", instance: INSTANCE, envelope: { ok: true } }]);
    });

    it("delivers another node's request to the instance held here and replies to that node", async () => {
        const { relay, calls } = setup();
        const instance = await connect(relay, "instance");
        instance.handlers.message(JSON.stringify({ type: "hello" }));
        await flush();
        const id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a99";
        expect(relay.internal("/terminal/deliver", { instanceId: INSTANCE, id, origin: "b", envelope: { q: 1 } })).toEqual({
            status: 200,
            body: { held: true }
        });
        instance.handlers.message(JSON.stringify({ type: "response", id, envelope: { r: 1 } }));
        await flush();
        expect(calls.find((c) => c.op === "reply")).toEqual({
            op: "reply",
            node: "b",
            id,
            frame: { type: "response", envelope: { r: 1 } }
        });
    });

    it("drops a terminal that never says hello and times out an unanswered request", async () => {
        const { relay, advance } = setup();
        const silent = await connect(relay, "instance");
        advance(TERMINAL_LIMITS.helloMs + 1);
        relay.sweep();
        expect(silent.socket.closed?.code).toBe(TERMINAL_CLOSE.protocol);

        const instance = await connect(relay, "instance");
        instance.handlers.message(JSON.stringify({ type: "hello" }));
        await flush();
        const controller = await connect(relay, "controller");
        controller.handlers.message(JSON.stringify({ type: "request", instance: INSTANCE, envelope: {} }));
        await flush();
        advance(TERMINAL_LIMITS.requestMs + 1);
        relay.sweep();
        expect(controller.socket.sent).toEqual([{ type: "error", instance: INSTANCE, code: "timeout" }]);
    });

    it("tells waiting controllers when the instance goes away", async () => {
        const { relay, calls } = setup();
        const instance = await connect(relay, "instance");
        instance.handlers.message(JSON.stringify({ type: "hello" }));
        await flush();
        const controller = await connect(relay, "controller");
        controller.handlers.message(JSON.stringify({ type: "request", instance: INSTANCE, envelope: {} }));
        await flush();
        instance.handlers.close();
        expect(controller.socket.sent).toEqual([{ type: "error", instance: INSTANCE, code: "offline" }]);
        expect(calls.filter((c) => c.op === "presence").at(-1)).toMatchObject({ online: false });
        expect(relay.holds(INSTANCE)).toBe(false);
    });

    it("lets only the instance a request went to answer it", async () => {
        const { relay } = setup();
        const instance = await connect(relay, "instance");
        instance.handlers.message(JSON.stringify({ type: "hello" }));
        await flush();
        const controller = await connect(relay, "controller");
        controller.handlers.message(JSON.stringify({ type: "request", instance: INSTANCE, envelope: {} }));
        await flush();
        const { id } = instance.socket.sent[1] as { id: string };
        // A controller cannot forge the instance's answer.
        controller.handlers.message(JSON.stringify({ type: "response", id, envelope: { forged: true } }));
        await flush();
        expect(controller.socket.closed?.code).toBe(TERMINAL_CLOSE.protocol);
    });

    it("closes the terminals whose key has ended", async () => {
        const { relay, app } = setup();
        const instance = await connect(relay, "instance");
        instance.handlers.message(JSON.stringify({ type: "hello" }));
        await flush();
        app.mockImplementationOnce(async () => ({ ended: [INSTANCE] }));
        await relay.checkStanding();
        expect(instance.socket.closed?.code).toBe(TERMINAL_CLOSE.unauthorized);
    });

    it("cuts off a flood", async () => {
        const { relay } = setup();
        const controller = await connect(relay, "controller");
        for (let i = 0; i <= TERMINAL_LIMITS.burst; i++) controller.handlers.message(JSON.stringify({ type: "ping" }));
        expect(controller.socket.closed?.code).toBe(TERMINAL_CLOSE.flood);
    });
});

describe("terminal relay cross-node framing", () => {
    const call = {
        path: "/terminal/deliver" as const,
        body: { instanceId: INSTANCE, id: KEY, origin: "a", envelope: { blob: "x".repeat(40_000) } }
    };

    it("carries a large call in pieces that reassemble on the node it names only", () => {
        const pieces = encodeRemoteCall("b", USER, call)!;
        expect(pieces.length).toBeGreaterThan(1);
        for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(8000);

        const onB = createCallAssembler(() => "b");
        const onC = createCallAssembler(() => "c");
        let result = null;
        for (const piece of pieces) {
            expect(onC(piece)).toBeNull();
            result = onB(piece) ?? result;
        }
        expect(result).toEqual(call);
    });

    it("drops a call with a missing piece", () => {
        const pieces = encodeRemoteCall("b", USER, call)!;
        const onB = createCallAssembler(() => "b");
        const results = pieces.filter((_, i) => i !== 1).map((piece) => onB(piece));
        expect(results.every((r) => r === null)).toBe(true);
    });

    it("refuses a call larger than a frame", () => {
        const huge = { ...call, body: { ...call.body, envelope: "y".repeat(300 * 1024) } };
        expect(encodeRemoteCall("b", USER, huge)).toBeNull();
    });
});
