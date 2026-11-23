/**
 * The Polaris Terminal remote-control relay: the sidecar's socket rules
 * (`terminal-relay.mjs`) with fake sockets, and the cross-node framing
 * (`lib/terminal/relay.ts`) as pure functions.
 */

import { describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
    db: {} as Record<string, any>,
    granted: "" as string,
    linkLive: false
}));
vi.mock("@polaris/db", () => ({ prisma: fakes.db }));
vi.mock("@/lib/api-key-auth", () => ({ authenticateKeyToken: async () => null }));
vi.mock("@/lib/access/grants", () => ({
    grantedCapability: async () => fakes.granted,
    linkGrantStands: async () => fakes.linkLive
}));

import {
    authenticateRelaySocket,
    createCallAssembler,
    encodeRemoteCall,
    mintViewerTicket,
    routeTerminalRequest
} from "../../src/lib/terminal/relay";
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
        const { socket } = await connect(relay, "spy");
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

/** A greeted terminal and a controller on node "a". */
async function online(route: { allowed: boolean; node: string | null } = { allowed: true, node: "a" }) {
    const ctx = setup(route);
    const instance = await connect(ctx.relay, "instance");
    instance.handlers.message(JSON.stringify({ type: "hello" }));
    await flush();
    instance.socket.sent.length = 0;
    return { ...ctx, instance };
}

const watch = (pane = "p1") => JSON.stringify({ type: "watch", instance: INSTANCE, pane });

describe("terminal relay pane output", () => {
    it("attaches on the first watcher, fans output out to every watcher, and detaches after the last", async () => {
        const { relay, instance, calls } = await online();
        const one = await connect(relay, "controller");
        const two = await connect(relay, "controller");
        one.handlers.message(watch());
        two.handlers.message(watch());
        await flush();
        expect(calls.filter((call) => call.op === "route").map((call) => call.need)).toEqual(["view", "view"]);
        expect(instance.socket.sent).toEqual([{ type: "attach", pane: "p1" }]);
        expect(one.socket.sent).toContainEqual({ type: "watching", instance: INSTANCE, pane: "p1" });

        instance.handlers.message(JSON.stringify({ type: "output", pane: "p1", data: "aGk=" }));
        await flush();
        const frame = { type: "output", instance: INSTANCE, pane: "p1", data: "aGk=" };
        expect(one.socket.sent).toContainEqual(frame);
        expect(two.socket.sent).toContainEqual(frame);

        one.handlers.message(JSON.stringify({ type: "unwatch", instance: INSTANCE, pane: "p1" }));
        await flush();
        expect(instance.socket.sent).toHaveLength(1);
        two.handlers.close();
        expect(instance.socket.sent).toEqual([
            { type: "attach", pane: "p1" },
            { type: "detach", pane: "p1" }
        ]);
        expect(relay.watchers(INSTANCE, "p1")).toBe(0);
    });

    it("drops output nobody watches and output past the pane's byte rate, then marks the gap", async () => {
        const { relay, instance, advance } = await online();
        instance.handlers.message(JSON.stringify({ type: "output", pane: "p1", data: "x" }));
        const viewer = await connect(relay, "controller");
        viewer.handlers.message(watch());
        await flush();
        const big = "a".repeat(200 * 1024);
        for (let i = 0; i < 6; i++) instance.handlers.message(JSON.stringify({ type: "output", pane: "p1", data: big }));
        await flush();
        const outputs = () => viewer.socket.sent.filter((frame) => frame.type === "output");
        expect(outputs()).toHaveLength(Math.floor(TERMINAL_LIMITS.outputBurstBytes / big.length));
        advance(2_000);
        instance.handlers.message(JSON.stringify({ type: "output", pane: "p1", data: "b" }));
        await flush();
        expect(outputs().at(-1)).toMatchObject({ data: "b", gap: true });
    });

    it("refuses a watch the caller may not see, and ends watches when the terminal leaves", async () => {
        const denied = await online({ allowed: false, node: null });
        const nosy = await connect(denied.relay, "controller");
        nosy.handlers.message(watch());
        await flush();
        expect(nosy.socket.sent).toContainEqual({ type: "watch_end", instance: INSTANCE, pane: "p1", code: "not_found" });
        expect(denied.instance.socket.sent).toEqual([]);

        const { relay, instance } = await online();
        const viewer = await connect(relay, "controller");
        viewer.handlers.message(watch());
        await flush();
        instance.handlers.close();
        expect(viewer.socket.sent).toContainEqual({ type: "watch_end", instance: INSTANCE, pane: "p1", code: "offline" });
        expect(relay.watchers(INSTANCE, "p1")).toBe(0);
    });

    it("caps the panes one socket watches", async () => {
        const { relay } = await online();
        const greedy = await connect(relay, "controller");
        for (let i = 0; i <= TERMINAL_LIMITS.watches; i++) greedy.handlers.message(watch(`p${i}`));
        await flush();
        expect(greedy.socket.sent.filter((frame) => frame.type === "watching")).toHaveLength(TERMINAL_LIMITS.watches);
        expect(greedy.socket.sent.at(-1)).toMatchObject({ type: "watch_end", code: "busy" });
    });

    it("watches a terminal on another node once per node and fans its stream out here", async () => {
        const { relay, calls } = setup({ allowed: true, node: "b" });
        const one = await connect(relay, "controller");
        const two = await connect(relay, "controller");
        one.handlers.message(watch());
        two.handlers.message(watch());
        await flush();
        expect(calls.filter((call) => call.op === "watch")).toEqual([
            { op: "watch", node: "b", origin: "a", instanceId: INSTANCE, pane: "p1", on: true }
        ]);
        relay.internal("/terminal/stream", { instanceId: INSTANCE, pane: "p1", frame: { type: "output", data: "aGk=" } });
        expect(two.socket.sent).toContainEqual({ type: "output", instance: INSTANCE, pane: "p1", data: "aGk=" });
        one.handlers.close();
        two.handlers.close();
        expect(calls.filter((call) => call.op === "watch").at(-1)).toMatchObject({ node: "b", on: false });
    });

    it("streams a pane held here to the nodes that asked for it", async () => {
        const { relay, instance, calls } = await online();
        expect(relay.internal("/terminal/watch", { instanceId: INSTANCE, pane: "p1", origin: "b", on: true })?.body).toEqual({
            held: true
        });
        expect(instance.socket.sent).toEqual([{ type: "attach", pane: "p1" }]);
        instance.handlers.message(JSON.stringify({ type: "output", pane: "p1", data: "aGk=" }));
        await flush();
        expect(calls).toContainEqual({
            op: "stream",
            node: "b",
            instanceId: INSTANCE,
            pane: "p1",
            frame: { type: "output", instance: INSTANCE, pane: "p1", data: "aGk=" }
        });
        relay.internal("/terminal/watch", { instanceId: INSTANCE, pane: "p1", origin: "b", on: false });
        expect(instance.socket.sent.at(-1)).toEqual({ type: "detach", pane: "p1" });
    });

    it("keeps a web viewer to the one terminal its ticket names", async () => {
        const { relay, app } = await online();
        app.mockImplementation(async (body: Record<string, unknown>) =>
            body.op === "auth" ? { userId: USER, keyId: null, bound: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a59" } : { allowed: true, node: "a" }
        );
        const viewer = await connect(relay, "viewer", "ticket");
        viewer.handlers.message(watch());
        await flush();
        expect(viewer.socket.closed).toBeNull();
        expect(viewer.socket.sent).toContainEqual({ type: "watch_end", instance: INSTANCE, pane: "p1", code: "not_found" });
    });

    it("lets a view share list panes, and asks for control to type", async () => {
        const { relay, app, calls } = await online();
        const LINK = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a58";
        app.mockImplementation(async (body: Record<string, unknown>) => {
            calls.push(body);
            return body.op === "auth" ? { userId: USER, keyId: null, bound: INSTANCE, linkId: LINK } : { allowed: false, node: null };
        });
        const viewer = await connect(relay, "viewer", "ticket");
        const request = (kind: string) =>
            JSON.stringify({ type: "request", instance: INSTANCE, envelope: { request_id: kind, action: { kind, params: null } } });
        viewer.handlers.message(request("pane.list"));
        await flush();
        viewer.handlers.message(request("input.insert"));
        await flush();
        viewer.handlers.message(request("history.list"));
        await flush();
        const routes = calls.filter((c) => c.op === "route");
        expect(routes.map((c) => c.need)).toEqual(["view", "control", "control"]);
        expect(routes.every((c) => c.linkId === LINK)).toBe(true);
    });

    it("carries a link's id into the standing check", async () => {
        const { relay, app, calls } = await online();
        const LINK = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a58";
        app.mockImplementation(async (body: Record<string, unknown>) => {
            calls.push(body);
            if (body.op === "auth") return { userId: USER, keyId: null, bound: INSTANCE, linkId: LINK };
            if (body.op === "standing") return { ended: [], withdrawn: [0] };
            return { allowed: true, node: "a" };
        });
        const viewer = await connect(relay, "viewer", "ticket");
        viewer.handlers.message(watch());
        await flush();
        await relay.checkStanding();
        const standing = calls.find((c) => c.op === "standing") as { watches: Record<string, unknown>[] };
        expect(standing.watches).toEqual([{ userId: USER, keyId: null, linkId: LINK, instanceId: INSTANCE }]);
        expect(viewer.socket.sent.at(-1)).toEqual({ type: "watch_end", instance: INSTANCE, pane: "p1", code: "not_found" });
    });

    it("ends a watch whose share was withdrawn at the standing check", async () => {
        const { relay, app } = await online();
        const viewer = await connect(relay, "controller");
        viewer.handlers.message(watch());
        await flush();
        app.mockImplementation(async (body: Record<string, unknown>) =>
            body.op === "standing" ? { ended: [], withdrawn: [0] } : { ok: true }
        );
        await relay.checkStanding();
        expect(viewer.socket.sent.at(-1)).toEqual({ type: "watch_end", instance: INSTANCE, pane: "p1", code: "not_found" });
        expect(relay.watchers(INSTANCE, "p1")).toBe(0);
    });
});

describe("routeTerminalRequest", () => {
    const row = { userId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5f", apiKeyId: KEY, relayNode: "a" };
    const standing = { revokedAt: null, enabled: true, expiresAt: null, user: { bannedAt: null } };
    const ask = (need: "view" | "control", keyId: string | null = KEY) =>
        routeTerminalRequest({ userId: USER, keyId, instanceId: INSTANCE, need });

    it("lets somebody else in only as far as a share of it reaches", async () => {
        fakes.db.terminalInstance = { findUnique: async () => row };
        fakes.db.apiKey = { findUnique: async () => standing };
        fakes.db.user = { findUnique: async () => ({ bannedAt: null }) };
        fakes.granted = "";
        expect(await ask("view")).toEqual({ allowed: false, node: null });
        fakes.granted = "view";
        expect(await ask("view")).toEqual({ allowed: true, node: "a" });
        expect(await ask("control")).toEqual({ allowed: false, node: null });
        fakes.granted = "control";
        expect(await ask("control", null)).toEqual({ allowed: true, node: "a" });
        fakes.db.user = { findUnique: async () => ({ bannedAt: new Date() }) };
        expect(await ask("view", null)).toEqual({ allowed: false, node: null });
    });

    it("never reads a link's ticket as the owner, and lets it only watch while it stands", async () => {
        fakes.db.terminalInstance = { findUnique: async () => row };
        fakes.db.apiKey = { findUnique: async () => standing };
        fakes.db.user = { findUnique: async () => ({ bannedAt: null }) };
        fakes.granted = "control";
        const LINK = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a58";
        const viaLink = (need: "view" | "control") =>
            routeTerminalRequest({ userId: row.userId, keyId: null, linkId: LINK, instanceId: INSTANCE, need });
        fakes.linkLive = true;
        expect(await viaLink("view")).toEqual({ allowed: true, node: "a" });
        expect(await viaLink("control")).toEqual({ allowed: false, node: null });
        fakes.linkLive = false;
        expect(await viaLink("view")).toEqual({ allowed: false, node: null });
        fakes.linkLive = true;
        fakes.db.user = { findUnique: async () => ({ bannedAt: new Date() }) };
        expect(await viaLink("view")).toEqual({ allowed: false, node: null });
    });
});

describe("viewer tickets", () => {
    it("carries the link a ticket was minted for, once", async () => {
        const rows: Record<string, any>[] = [];
        fakes.db.deployTicket = {
            create: async ({ data }: { data: Record<string, unknown> }) => rows.push({ id: String(rows.length), usedAt: null, ...data }),
            findUnique: async ({ where }: { where: { tokenHash: string } }) => rows.find((r) => r.tokenHash === where.tokenHash) ?? null,
            updateMany: async ({ where }: { where: { id: string; usedAt: null } }) => {
                const found = rows.find((r) => r.id === where.id && r.usedAt === null);
                if (found) found.usedAt = new Date();
                return { count: found ? 1 : 0 };
            }
        };
        const LINK = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a58";
        const linked = await mintViewerTicket(USER, INSTANCE, LINK);
        const own = await mintViewerTicket(USER, INSTANCE);
        expect(rows.every((r) => r.mode === "relay")).toBe(true);
        expect(await authenticateRelaySocket({ token: linked, role: "viewer" })).toEqual({
            userId: USER,
            keyId: null,
            bound: INSTANCE,
            linkId: LINK
        });
        expect(await authenticateRelaySocket({ token: linked, role: "viewer" })).toBeNull();
        expect(await authenticateRelaySocket({ token: own, role: "viewer" })).toEqual({ userId: USER, keyId: null, bound: INSTANCE });
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
