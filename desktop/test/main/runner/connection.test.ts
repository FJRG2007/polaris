import { describe, expect, it } from "vitest";
import { afterClose, RunnerConnection, runnerSocketUrl, type RunnerSocket, type ServerFrame } from "@/main/runner/connection";

const RUNNER_ID = "0b6c3f0e-2f7a-4c47-9d1a-6a4b1d6e8f10";
const SESSION_ID = "4a1f7a52-8a9c-4f0e-9b7d-2c5e6f1a3b4c";

class FakeSocket implements RunnerSocket {
    readyState = 0;
    sent: Record<string, unknown>[] = [];
    closed: number | null = null;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown; }) => void) | null = null;
    onclose: ((event: { code: number; }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor(readonly url: string, readonly headers: Record<string, string>) {}
    send(data: string): void {
        this.sent.push(JSON.parse(data));
    }
    close(code?: number): void {
        this.closed = code ?? 1000;
    }
    open(): void {
        this.readyState = 1;
        this.onopen?.({});
    }
    receive(frame: Record<string, unknown>): void {
        this.onmessage?.({ data: JSON.stringify({ v: 1, ...frame }) });
    }
    drop(code: number): void {
        this.readyState = 3;
        this.onclose?.({ code });
    }
}

const welcome = { type: "welcome", runnerId: RUNNER_ID, protocol: 1, limits: { frameBytes: 1048576, promptChars: 100000, heartbeatMs: 20000, heartbeatTimeoutMs: 60000 } };

function harness() {
    const sockets: FakeSocket[] = [];
    const timers: { run: () => void; ms: number; }[] = [];
    const commands: ServerFrame[] = [];
    const states: string[] = [];
    const connection = new RunnerConnection({
        server: "https://polaris.example.test",
        token: "plr_run_fixture",
        runnerVersion: "0.1.34",
        openSocket: (url, headers) => {
            const socket = new FakeSocket(url, headers);
            sockets.push(socket);
            return socket;
        },
        capabilities: async () => ({ type: "capabilities", os: { platform: "win32", release: "10", arch: "x64" }, hostname: "fixture-pc", shells: [], clis: [], maxSessions: 8, features: ["toolchain", "claude-chat"] }),
        sessions: () => [SESSION_ID],
        onCommand: (frame) => commands.push(frame),
        onState: (state) => states.push(state),
        setTimer: (run, ms) => timers.push({ run, ms }),
        clearTimer: () => undefined
    });
    return { connection, sockets, timers, commands, states };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runner connection", () => {
    it("dials the runner path with the credential as a Bearer token", () => {
        expect(runnerSocketUrl("https://polaris.example.test")).toBe("wss://polaris.example.test/api/deploy/ws/runner");
        expect(runnerSocketUrl("http://192.0.2.10:3000")).toBe("ws://192.0.2.10:3000/api/deploy/ws/runner");
        const { connection, sockets } = harness();
        connection.start();
        expect(sockets[0]!.headers).toEqual({ Authorization: "Bearer plr_run_fixture" });
    });

    it("says hello, answers welcome with capabilities, and beats", async () => {
        const { connection, sockets, timers, states } = harness();
        connection.start();
        const socket = sockets[0]!;
        socket.open();
        expect(socket.sent[0]).toEqual({ v: 1, type: "hello", runnerVersion: "0.1.34", protocol: { min: 1, max: 1 } });
        socket.receive(welcome);
        await settle();
        expect(states).toContain("online");
        expect(socket.sent[1]).toMatchObject({ v: 1, type: "capabilities", features: ["toolchain", "claude-chat"] });
        const beat = timers.find((timer) => timer.ms === 20000)!;
        beat.run();
        expect(socket.sent[2]).toEqual({ v: 1, type: "heartbeat", sessions: [SESSION_ID] });
    });

    it("hands session frames on and drops unreadable ones", async () => {
        const { connection, sockets, commands } = harness();
        connection.start();
        sockets[0]!.open();
        sockets[0]!.receive(welcome);
        await settle();
        sockets[0]!.receive({ type: "interrupt", sessionId: SESSION_ID });
        sockets[0]!.receive({ type: "interrupt", sessionId: "not-a-uuid" });
        sockets[0]!.onmessage?.({ data: "{" });
        await settle();
        expect(commands).toEqual([{ v: 1, type: "interrupt", sessionId: SESSION_ID }]);
    });

    it("reconnects on a dropped socket with backoff, and stops for good on a revoked credential", async () => {
        const { connection, sockets, timers, states } = harness();
        connection.start();
        sockets[0]!.open();
        sockets[0]!.drop(1006);
        expect(states.at(-1)).toBe("offline");
        expect(timers.at(-1)!.ms).toBe(2000);
        timers.at(-1)!.run();
        expect(sockets).toHaveLength(2);
        sockets[1]!.drop(1006);
        expect(timers.at(-1)!.ms).toBe(4000);
        timers.at(-1)!.run();
        sockets[2]!.drop(4005);
        expect(states.at(-1)).toBe("unpaired");
        const count = timers.length;
        expect(timers.length).toBe(count);
        expect(sockets).toHaveLength(3);
    });

    it("never sends before welcome and refuses an oversized frame", async () => {
        const { connection, sockets } = harness();
        connection.start();
        sockets[0]!.open();
        expect(connection.send({ type: "heartbeat", sessions: [] })).toBe(false);
        sockets[0]!.receive(welcome);
        await settle();
        const huge = "x".repeat(1024 * 1024);
        expect(connection.send({ type: "error", code: "x", message: huge })).toBe(false);
    });

    it("reads every close code the protocol defines", () => {
        expect(afterClose(4001)).toEqual({ state: "unpaired", retry: false });
        expect(afterClose(4002)).toEqual({ state: "outdated", retry: false });
        expect(afterClose(4003)).toEqual({ state: "replaced", retry: false });
        expect(afterClose(4004)).toEqual({ state: "offline", retry: true });
        expect(afterClose(4008)).toMatchObject({ state: "offline", retry: true, pauseMs: 30000 });
    });
});
