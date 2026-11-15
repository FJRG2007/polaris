import { describe, expect, it, vi } from "vitest";
import { FakePipe, noSleep, RECORDED } from "./fake-pipe";
import { pipeStream, PipeClosedError } from "@/lib/agents/acp/transport";
import { CLIENT_CAPABILITIES, connectAcp, permissionOutcome } from "@/lib/agents/acp/client";
import type { RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk";

function connect(pipe: FakePipe, choose: (request: RequestPermissionRequest) => string | null = () => "allow-once") {
    const updates: SessionNotification["update"][] = [];
    const asked: RequestPermissionRequest[] = [];
    const dropped: string[] = [];
    const client = connectAcp(pipeStream(pipe, { sleep: noSleep, onDropped: (what) => dropped.push(what) }), {
        onUpdate: (notification) => {
            updates.push(notification.update);
        },
        onPermission: async (request) => {
            asked.push(request);
            return choose(request);
        }
    });
    return { client, updates, asked, dropped };
}

describe("ACP client over the session pipe", () => {
    it("plays a whole recorded conversation: start, new session, a prompt turn with a permission", async () => {
        const pipe = new FakePipe();
        const { client, updates, asked } = connect(pipe);

        const init = await client.initialize();
        expect(init.agentCapabilities?.loadSession).toBe(true);
        expect(pipe.received[0]).toMatchObject({
            method: "initialize",
            params: { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES }
        });

        const session = await client.newSession("/session/work");
        expect(session.sessionId).toBe("sess_abc123def456");
        expect(pipe.received[1]).toMatchObject({ method: "session/new", params: { cwd: "/session/work", mcpServers: [] } });

        const turn = await client.prompt(session.sessionId, "Can you analyze this code for potential issues?");
        expect(turn.stopReason).toBe("end_turn");

        // The updates arrive in the order the agent wrote them.
        await vi.waitFor(() => expect(updates).toHaveLength(5));
        expect(updates.map((update) => update.sessionUpdate)).toEqual([
            "plan",
            "agent_message_chunk",
            "tool_call",
            "tool_call_update",
            "tool_call_update"
        ]);
        // The permission request reached the handler and its answer went back
        // under the agent's own request id.
        expect(asked).toHaveLength(1);
        expect(asked[0]!.options.map((option) => option.optionId)).toEqual(["allow-once", "reject-once"]);
        expect(pipe.received).toContainEqual({
            jsonrpc: "2.0",
            id: 5,
            result: { outcome: { outcome: "selected", optionId: "allow-once" } }
        });
        client.close();
    });

    it("cancels a permission the handler answers with an option nobody offered", async () => {
        const pipe = new FakePipe();
        const { client } = connect(pipe, () => "allow-always");
        await client.initialize();
        const session = await client.newSession("/session/work");
        await client.prompt(session.sessionId, "go");
        expect(pipe.received).toContainEqual({ jsonrpc: "2.0", id: 5, result: { outcome: { outcome: "cancelled" } } });
        client.close();
    });

    it("sends a cancel as a notification", async () => {
        const pipe = new FakePipe();
        const { client } = connect(pipe);
        await client.initialize();
        await client.cancel("sess_abc123def456");
        await vi.waitFor(() =>
            expect(pipe.received).toContainEqual({
                jsonrpc: "2.0",
                method: "session/cancel",
                params: { sessionId: "sess_abc123def456" }
            })
        );
        client.close();
    });

    it("drops frames that are not JSON-RPC, and keeps going", async () => {
        const pipe = new FakePipe((frame, self) => {
            if (frame.method !== "initialize") return;
            self.emit("this is not json");
            self.emit({ jsonrpc: "1.0", method: "session/update", params: {} });
            self.emit({ jsonrpc: "2.0", id: frame.id, result: {}, error: { code: 1, message: "both" } });
            self.emit({ ...RECORDED[0]!, id: frame.id });
        });
        const { client, dropped } = connect(pipe);
        const init = await client.initialize();
        expect(init.protocolVersion).toBe(1);
        expect(dropped).toEqual(["session/update", "response"]);
        client.close();
    });

    it("refuses an agent on another protocol version", async () => {
        const pipe = new FakePipe((frame, self) => {
            if (frame.method === "initialize")
                self.emit({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 2 } });
        });
        const { client } = connect(pipe);
        await expect(client.initialize()).rejects.toThrow(/version 2/);
    });

    it("rejects what is waiting when the agent is restarted underneath", async () => {
        const pipe = new FakePipe((frame, self) => {
            if (frame.method === "initialize") self.generation = "1700000000000000001-43";
        });
        const { client } = connect(pipe);
        await expect(client.initialize()).rejects.toThrow();
        await client.closed.catch(() => undefined);
    });

    it("ends when the agent exits", async () => {
        const pipe = new FakePipe((frame, self) => {
            if (frame.method === "initialize") self.exitCode = 1;
        });
        const { client } = connect(pipe);
        await expect(client.initialize()).rejects.toThrow();
    });
});

describe("pipeStream", () => {
    it("fails with not-running when no agent was ever started", async () => {
        const pipe = new FakePipe();
        pipe.running = false;
        const reader = pipeStream(pipe, { sleep: noSleep }).readable.getReader();
        const error = await reader.read().then(
            () => null,
            (caught: unknown) => caught
        );
        expect(error).toBeInstanceOf(PipeClosedError);
        expect((error as PipeClosedError).reason).toBe("not-running");
    });

    it("gives up after reads fail in a row", async () => {
        const io = { read: vi.fn().mockRejectedValue(new Error("ssh closed")), write: vi.fn() };
        const reader = pipeStream(io, { sleep: noSleep, maxFailures: 3 }).readable.getReader();
        await expect(reader.read()).rejects.toMatchObject({ reason: "unreadable" });
        expect(io.read).toHaveBeenCalledTimes(3);
    });

    it("cuts a large frame into writes a command can carry", async () => {
        const pipe = new FakePipe(() => undefined);
        const stream = pipeStream(pipe, { sleep: noSleep });
        const reader = stream.readable.getReader();
        void reader.read().catch(() => undefined);
        const writer = stream.writable.getWriter();
        await writer.write({ jsonrpc: "2.0", method: "x", params: { text: "a".repeat(120 * 1024) } });
        expect(pipe.writes.length).toBeGreaterThanOrEqual(3);
        expect(pipe.writes.every((piece) => piece.byteLength <= 48 * 1024)).toBe(true);
        expect(pipe.received[0]).toMatchObject({ method: "x" });
    });
});

describe("permissionOutcome", () => {
    const request = RECORDED[5]!.params as RequestPermissionRequest;

    it("selects an offered option", () => {
        expect(permissionOutcome(request, "reject-once")).toEqual({
            outcome: { outcome: "selected", optionId: "reject-once" }
        });
    });

    it("cancels on no answer or one not offered", () => {
        expect(permissionOutcome(request, null)).toEqual({ outcome: { outcome: "cancelled" } });
        expect(permissionOutcome(request, "allow-always")).toEqual({ outcome: { outcome: "cancelled" } });
    });
});
