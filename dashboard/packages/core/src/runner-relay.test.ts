import { describe, expect, it, vi } from "vitest";
import { RUNNER_CLOSE, RUNNER_LIMITS } from "./runner-protocol.js";
import { RunnerRelay, type RelayDeps, type RelaySocket } from "./runner-relay.js";

const RUNNER = "0190a5f2-2222-7000-8000-000000000001";
const USER = "0190a5f2-3333-7000-8000-000000000001";
const SESSION = "0190a5f2-1111-7000-8000-000000000001";

class FakeSocket implements RelaySocket {
    bufferedAmount = 0;
    sent: Array<Record<string, unknown>> = [];
    closed: { code: number; reason: string } | null = null;
    send(data: string) {
        this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }
    close(code: number, reason: string) {
        this.closed = { code, reason };
    }
}

const hello = JSON.stringify({ v: 1, type: "hello", runnerVersion: "0.1.0", protocol: { min: 1, max: 1 } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(overrides: Partial<RelayDeps> = {}) {
    let clock = 1_000_000;
    const deps = {
        authenticate: vi.fn(async (token: string) => (token === "good" ? { runnerId: RUNNER, userId: USER } : null)),
        deliver: vi.fn(async () => null),
        presence: vi.fn(async () => undefined),
        now: () => clock,
        ...overrides
    };
    const relay = new RunnerRelay(deps);
    return { relay, deps, advance: (ms: number) => (clock += ms) };
}

async function connect(relay: RunnerRelay, token = "good") {
    const socket = new FakeSocket();
    const handlers = relay.accept(socket, token);
    handlers.message(hello);
    await flush();
    await flush();
    return { socket, handlers };
}

describe("runner relay", () => {
    it("refuses a wrong credential without reading anything", async () => {
        const { relay, deps } = setup();
        const { socket } = await connect(relay, "bad");
        expect(socket.closed?.code).toBe(RUNNER_CLOSE.unauthorized);
        expect(deps.deliver).not.toHaveBeenCalled();
        expect(relay.holds(RUNNER)).toBe(false);
    });

    it("welcomes a runner and marks it online", async () => {
        const { relay, deps } = setup();
        const { socket } = await connect(relay);
        expect(socket.sent[0]?.type).toBe("welcome");
        expect(relay.holds(RUNNER)).toBe(true);
        expect(deps.presence).toHaveBeenCalledWith({ runnerId: RUNNER, userId: USER }, true);
    });

    it("refuses a protocol range it does not speak", async () => {
        const { relay } = setup();
        const socket = new FakeSocket();
        relay.accept(socket, "good").message(
            JSON.stringify({ v: 9, type: "hello", runnerVersion: "9.0.0", protocol: { min: 9, max: 9 } })
        );
        await flush();
        await flush();
        expect(socket.closed?.code).toBe(RUNNER_CLOSE.protocol);
    });

    it("keeps one live connection per runner", async () => {
        const { relay, deps } = setup();
        const first = await connect(relay);
        const second = await connect(relay);
        expect(first.socket.closed?.code).toBe(RUNNER_CLOSE.replaced);
        expect(second.socket.closed).toBeNull();
        expect(relay.holds(RUNNER)).toBe(true);
        // The replaced one leaving does not mark the runner offline.
        first.handlers.close();
        expect(deps.presence).not.toHaveBeenCalledWith(expect.anything(), false);
    });

    it("drops a silent runner and one that never said hello", async () => {
        const { relay, advance, deps } = setup();
        const { socket } = await connect(relay);
        const mute = new FakeSocket();
        relay.accept(mute, "good");
        await flush();
        advance(RUNNER_LIMITS.helloTimeoutMs + 1);
        relay.sweep();
        expect(mute.closed?.code).toBe(RUNNER_CLOSE.protocol);
        advance(RUNNER_LIMITS.heartbeatTimeoutMs);
        relay.sweep();
        expect(socket.closed?.code).toBe(RUNNER_CLOSE.heartbeat);
        expect(deps.presence).toHaveBeenCalledWith({ runnerId: RUNNER, userId: USER }, false);
    });

    it("answers a heartbeat and keeps the connection alive", async () => {
        const { relay, advance } = setup();
        const { socket, handlers } = await connect(relay);
        advance(RUNNER_LIMITS.heartbeatTimeoutMs - 1000);
        handlers.message(JSON.stringify({ v: 1, type: "heartbeat", sessions: [] }));
        await flush();
        advance(2000);
        relay.sweep();
        expect(socket.closed).toBeNull();
        expect(socket.sent.some((frame) => frame.type === "heartbeat.ack")).toBe(true);
    });

    it("cuts off a flood", async () => {
        const { relay } = setup();
        const { socket, handlers } = await connect(relay);
        for (let i = 0; i < RUNNER_LIMITS.burst + 5; i++)
            handlers.message(JSON.stringify({ v: 1, type: "heartbeat", sessions: [] }));
        await flush();
        expect(socket.closed?.code).toBe(RUNNER_CLOSE.rateLimited);
    });

    it("relays a permission decision back to the runner", async () => {
        const decision = { type: "permission.decision" as const, requestId: SESSION, sessionId: SESSION, decision: { ok: true } };
        const { relay } = setup({ deliver: vi.fn(async () => decision) });
        const { socket, handlers } = await connect(relay);
        handlers.message(JSON.stringify({ v: 1, type: "permission.request", requestId: SESSION, sessionId: SESSION, payload: {} }));
        await flush();
        expect(socket.sent.at(-1)?.type).toBe("permission.decision");
    });

    it("sends commands only to a runner held here, and holds back keystrokes when it is behind", async () => {
        const { relay } = setup();
        expect(relay.send(RUNNER, { type: "interrupt", sessionId: SESSION })).toBe(false);
        const { socket } = await connect(relay);
        expect(relay.send(RUNNER, { type: "interrupt", sessionId: SESSION })).toBe(true);
        socket.bufferedAmount = RUNNER_LIMITS.bufferedBytes + 1;
        expect(relay.send(RUNNER, { type: "terminal.input", sessionId: SESSION, data: "YQ==" })).toBe(false);
        expect(relay.send(RUNNER, { type: "session.stop", sessionId: SESSION })).toBe(true);
    });

    it("fans terminal output to viewers of that runner's session and skips a slow one", async () => {
        const { relay, deps } = setup();
        const { handlers } = await connect(relay);
        const fast = { bufferedAmount: 0, write: vi.fn() };
        const slow = { bufferedAmount: RUNNER_LIMITS.bufferedBytes + 1, write: vi.fn() };
        const other = { bufferedAmount: 0, write: vi.fn() };
        relay.watchTerminal(RUNNER, SESSION, fast);
        relay.watchTerminal(RUNNER, SESSION, slow);
        relay.watchTerminal("0190a5f2-2222-7000-8000-000000000009", SESSION, other);
        handlers.message(JSON.stringify({ v: 1, type: "terminal.output", sessionId: SESSION, seq: 0, data: "aGk=" }));
        await flush();
        expect(fast.write).toHaveBeenCalledWith(Buffer.from("hi"));
        expect(slow.write).not.toHaveBeenCalled();
        expect(other.write).not.toHaveBeenCalled();
        // Terminal output never goes to the dashboard.
        expect(deps.deliver).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "terminal.output" }));
    });

    it("closes a revoked runner", async () => {
        const { relay } = setup();
        const { socket } = await connect(relay);
        expect(relay.close(RUNNER)).toBe(true);
        expect(socket.closed?.code).toBe(RUNNER_CLOSE.revoked);
        expect(relay.holds(RUNNER)).toBe(false);
    });
});
