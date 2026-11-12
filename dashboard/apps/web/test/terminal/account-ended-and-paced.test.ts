/**
 * A terminal ends with its account (VULN-0038), and a viewer that stops reading
 * cannot make the sidecar hold a shell's output without end (VULN-0042).
 */

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
    ACCOUNT_ENDED,
    OUTPUT_HIGH_WATER,
    OUTPUT_MAX_QUEUED,
    createSessionRegistry,
    sendPaced,
    sessionsRequest
} from "../../terminal-sessions.mjs";

class FakeShell extends EventEmitter {
    paused = false;
    closed = false;
    write(): void {}
    pause(): void {
        this.paused = true;
    }
    resume(): void {
        this.paused = false;
    }
    isPaused(): boolean {
        return this.paused;
    }
}

function open(registry: ReturnType<typeof createSessionRegistry>, userId: string, hostId = "h1") {
    const stream = new FakeShell();
    const session = registry.add({
        userId,
        hostId,
        mode: "ssh",
        stream,
        resize: () => undefined,
        close: () => {
            stream.closed = true;
        }
    });
    return { stream, session };
}

/** A socket whose peer reads nothing until `drain` is called. */
class SlowSocket {
    readonly OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    closedWith: number | null = null;
    private pending: Array<{ size: number; done: () => void }> = [];
    send(chunk: Buffer, done: () => void): void {
        this.bufferedAmount += chunk.length;
        this.pending.push({ size: chunk.length, done });
    }
    close(code: number): void {
        this.closedWith = code;
        this.readyState = 3;
    }
    drain(): void {
        for (const item of this.pending.splice(0)) {
            this.bufferedAmount -= item.size;
            item.done();
        }
    }
}

describe("a terminal whose account was ended", () => {
    it("is closed on every server, and nobody else's is touched", () => {
        const registry = createSessionRegistry();
        const banned = [open(registry, "u1", "h1"), open(registry, "u1", "h2")];
        const other = open(registry, "u2", "h1");
        const closes: number[] = [];
        registry.attach(banned[0]!.session, { send: () => undefined, close: (code: number) => closes.push(code) });

        expect(registry.userIds().sort()).toEqual(["u1", "u2"]);
        expect(registry.endUser("u1")).toBe(2);
        expect(banned.every((shell) => shell.stream.closed)).toBe(true);
        expect(closes).toEqual([ACCOUNT_ENDED]);
        expect(other.stream.closed).toBe(false);
        expect(registry.userIds()).toEqual(["u2"]);
    });

    it("is ended by the web app's end-user call, behind the internal key", async () => {
        const registry = createSessionRegistry();
        open(registry, "u1");
        const call = (key: string) =>
            sessionsRequest(registry, "secret", {
                method: "POST",
                url: new URL("http://sidecar/internal/terminal-sessions"),
                key,
                readBody: async () => JSON.stringify({ action: "end-user", userId: "u1" })
            });
        expect((await call("wrong")).status).toBe(403);
        expect(registry.size()).toBe(1);
        const answer = await call("secret");
        expect(answer).toEqual({ status: 200, body: { ok: true, ended: 1 } });
        expect(registry.size()).toBe(0);
    });

    it("hands the end-user call to the sidecar's own hook for every kind", async () => {
        const registry = createSessionRegistry();
        const asked: string[] = [];
        await sessionsRequest(
            registry,
            "secret",
            {
                method: "POST",
                url: new URL("http://sidecar/internal/terminal-sessions"),
                key: "secret",
                readBody: async () => JSON.stringify({ action: "end-user", userId: "u9" })
            },
            { endUser: (id: string) => (asked.push(id), 3) }
        );
        expect(asked).toEqual(["u9"]);
    });
});

describe("a viewer that stops reading", () => {
    it("pauses the shell past the high mark and resumes it once drained", () => {
        const ws = new SlowSocket();
        const shell = new FakeShell();
        const chunk = Buffer.alloc(256 * 1024);
        for (let i = 0; i < 5; i += 1) sendPaced(ws as never, shell as never, chunk);
        expect(ws.bufferedAmount).toBeGreaterThan(OUTPUT_HIGH_WATER);
        expect(shell.paused).toBe(true);
        ws.drain();
        expect(shell.paused).toBe(false);
        expect(ws.closedWith).toBeNull();
    });

    it("ends the socket when one write leaves more than the ceiling queued", () => {
        const ws = new SlowSocket();
        const shell = new FakeShell();
        sendPaced(ws as never, shell as never, Buffer.alloc(OUTPUT_MAX_QUEUED + 1));
        expect(ws.closedWith).toBe(1013);
    });

    it("lets a detached shell flow again, into the bounded scrollback", () => {
        const registry = createSessionRegistry();
        const { stream, session } = open(registry, "u1");
        const sink = { send: () => undefined, close: () => undefined };
        registry.attach(session, sink);
        stream.pause();
        registry.detach(session, sink);
        expect(stream.paused).toBe(false);
    });
});
