/**
 * Long-lived server shells (terminal-sessions.mjs): a closed socket leaves the
 * shell running, attaching again replays where it was, and every session ends
 * by design - idle, explicit close, or its shell exiting - within a per-user
 * cap, never visible to anybody but the user who opened it.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
    DEFAULT_SESSION_CAP,
    cleanName,
    createSessionRegistry,
    positiveInt
} from "../../terminal-sessions.mjs";
import { sessionFrame } from "../../src/app/(app)/apps/deploy/terminal-panel";
import { initialTab } from "../../src/app/(app)/apps/servers/server-terminals";
import {
    DEFAULT_TERMINAL_SESSION_CAP,
    MAX_TERMINAL_SESSION_CAP,
    parseTerminalSessionCap
} from "../../src/lib/terminal-session-cap";

class FakeShell extends EventEmitter {
    written: string[] = [];
    closed = false;
    write(data: unknown): void {
        this.written.push(String(data));
    }
}

function open(registry: ReturnType<typeof createSessionRegistry>, userId = "u1", hostId = "h1") {
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

function sink() {
    const sent: string[] = [];
    const closes: Array<[number, string]> = [];
    return {
        sent,
        closes,
        send: (chunk: Buffer | string) => sent.push(String(chunk)),
        close: (code: number, reason: string) => closes.push([code, reason])
    };
}

describe("server shell sessions", () => {
    it("keeps the shell running after the socket goes and replays it on reattach", () => {
        const registry = createSessionRegistry();
        const { stream, session } = open(registry);
        const first = sink();
        registry.attach(session, first);
        stream.emit("data", Buffer.from("$ make\r\n"));
        registry.detach(session, first);
        // Output while nobody watches still lands in the scrollback.
        stream.emit("data", Buffer.from("build done\r\n"));
        expect(stream.closed).toBe(false);

        const again = registry.find("u1", "h1", "ssh", session.id);
        expect(again).toBe(session);
        const second = sink();
        expect(String(registry.attach(session, second))).toBe("$ make\r\nbuild done\r\n");
        stream.emit("data", Buffer.from("$ "));
        expect(second.sent).toEqual(["$ "]);
        expect(first.sent).toEqual(["$ make\r\n"]);
    });

    it("bounds the scrollback to its newest bytes", () => {
        const registry = createSessionRegistry({ scrollbackBytes: 8 });
        const { stream, session } = open(registry);
        stream.emit("data", Buffer.from("aaaa"));
        stream.emit("data", Buffer.from("bbbb"));
        stream.emit("data", Buffer.from("cccc"));
        expect(String(registry.attach(session, sink()))).toBe("bbbbcccc");
        stream.emit("data", Buffer.from("0123456789"));
        expect(String(registry.attach(session, sink()))).toBe("23456789");
    });

    it("hands a session over to a second viewer and tells the first", () => {
        const registry = createSessionRegistry();
        const { session } = open(registry);
        const first = sink();
        registry.attach(session, first);
        registry.attach(session, sink());
        expect(first.closes).toEqual([[4007, "session opened elsewhere"]]);
        // The first socket's late close does not detach the new viewer.
        registry.detach(session, first);
        expect(registry.list("u1", "h1")[0].attached).toBe(true);
    });

    it("ends a session left detached past the idle limit, not an attached one", () => {
        let clock = 0;
        const registry = createSessionRegistry({ idleMs: 1000, now: () => clock });
        const watched = open(registry);
        registry.attach(watched.session, sink());
        const left = open(registry);
        const viewer = sink();
        registry.attach(left.session, viewer);
        registry.detach(left.session, viewer);

        clock = 999;
        // Output does not keep a session nobody returns to alive.
        left.stream.emit("data", Buffer.from("tick"));
        expect(registry.sweep()).toBe(0);
        clock = 1000;
        expect(registry.sweep()).toBe(1);
        expect(left.stream.closed).toBe(true);
        expect(watched.stream.closed).toBe(false);
        expect(registry.find("u1", "h1", "ssh", left.session.id)).toBeNull();
    });

    it("holds each user to the cap, counted on every server", () => {
        const registry = createSessionRegistry({ cap: 2 });
        open(registry, "u1", "h1");
        expect(registry.canOpen("u1")).toBe(true);
        open(registry, "u1", "h2");
        expect(registry.canOpen("u1")).toBe(false);
        expect(registry.count("u1")).toBe(2);
        // Somebody else's sessions are not counted against this user.
        expect(registry.canOpen("u2")).toBe(true);
    });

    it("uses the cap the ticket carries, and the default when it carries none", () => {
        const registry = createSessionRegistry({ cap: 3 });
        open(registry, "u1", "h1");
        open(registry, "u1", "h1");
        // The administrator lowered it to 2: no third.
        expect(registry.canOpen("u1", 2)).toBe(false);
        // A ticket from before the setting existed says nothing; the default holds.
        expect(registry.canOpen("u1", undefined)).toBe(true);
        expect(registry.canOpen("u1", 0)).toBe(true);
    });

    it("frees a place under the cap when a shell exits", () => {
        const registry = createSessionRegistry({ cap: 1 });
        const { stream, session } = open(registry);
        const viewer = sink();
        registry.attach(session, viewer);
        stream.emit("close");
        expect(viewer.closes).toEqual([[1000, ""]]);
        expect(registry.canOpen("u1")).toBe(true);
    });

    it("never lets one user list, attach to, rename or close another's session", () => {
        const registry = createSessionRegistry();
        const { stream, session } = open(registry, "u1", "h1");
        expect(registry.list("u2", "h1")).toEqual([]);
        expect(registry.find("u2", "h1", "ssh", session.id)).toBeNull();
        expect(registry.rename("u2", "h1", session.id, "mine")).toBe(false);
        expect(registry.close("u2", "h1", session.id)).toBe(false);
        expect(stream.closed).toBe(false);
        expect(registry.list("u1", "h1")[0].name).toBeNull();
    });

    it("finds a session only on the server and in the mode it was opened in", () => {
        const registry = createSessionRegistry();
        const { session } = open(registry, "u1", "h1");
        expect(registry.find("u1", "h2", "ssh", session.id)).toBeNull();
        expect(registry.find("u1", "h1", "ssh-root", session.id)).toBeNull();
        expect(registry.close("u1", "h2", session.id)).toBe(false);
    });

    it("renames and closes for the owner, telling the viewer it ended", () => {
        const registry = createSessionRegistry();
        const { stream, session } = open(registry);
        expect(registry.rename("u1", "h1", session.id, "  logs\u0007 ")).toBe(true);
        expect(registry.list("u1", "h1")[0].name).toBe("logs");
        const viewer = sink();
        registry.attach(session, viewer);
        expect(registry.close("u1", "h1", session.id)).toBe(true);
        expect(stream.closed).toBe(true);
        expect(viewer.closes).toEqual([[4006, "session ended"]]);
        expect(registry.size()).toBe(0);
    });

    it("numbers default names per server without reusing a closed one's", () => {
        const registry = createSessionRegistry();
        const a = open(registry).session;
        open(registry);
        registry.close("u1", "h1", a.id);
        expect(open(registry).session.number).toBe(3);
        expect(open(registry, "u1", "h2").session.number).toBe(1);
    });
});

describe("session settings and names", () => {
    it("reads limits from the environment with defaults in code", () => {
        expect(positiveInt(undefined, DEFAULT_SESSION_CAP)).toBe(DEFAULT_SESSION_CAP);
        expect(positiveInt("0", 5)).toBe(5);
        expect(positiveInt("abc", 5)).toBe(5);
        expect(positiveInt("25", 5)).toBe(25);
    });

    it("reads the per-user cap setting, falling back to the default in code", () => {
        expect(parseTerminalSessionCap(null)).toBe(DEFAULT_TERMINAL_SESSION_CAP);
        expect(parseTerminalSessionCap("3")).toBe(3);
        expect(parseTerminalSessionCap("0")).toBe(DEFAULT_TERMINAL_SESSION_CAP);
        expect(parseTerminalSessionCap("2.5")).toBe(DEFAULT_TERMINAL_SESSION_CAP);
        expect(parseTerminalSessionCap(String(MAX_TERMINAL_SESSION_CAP + 1))).toBe(
            DEFAULT_TERMINAL_SESSION_CAP
        );
    });

    it("cleans a name down to something printable and bounded", () => {
        expect(cleanName("   ")).toBeNull();
        expect(cleanName(42)).toBeNull();
        expect(cleanName("x".repeat(100))).toHaveLength(60);
    });
});

describe("the panel's view of sessions", () => {
    it("reads only the opening control frame as a session", () => {
        expect(sessionFrame('{"session":{"id":"abc","number":1}}')).toEqual({
            id: "abc",
            number: 1
        });
        expect(sessionFrame('{"session":42}')).toBeNull();
        expect(sessionFrame("plain output")).toBeNull();
        expect(sessionFrame(new ArrayBuffer(2))).toBeNull();
    });

    it("returns to the newest session in the mode asked for, or opens one", () => {
        const sessions = [
            { id: "a", name: null, number: 1, mode: "ssh" as const },
            { id: "b", name: null, number: 2, mode: "ssh-root" as const },
            { id: "c", name: null, number: 3, mode: "ssh" as const }
        ];
        expect(initialTab(sessions, false)).toBe("c");
        expect(initialTab(sessions, true)).toBe("b");
        expect(initialTab([], false)).toBe("pending");
    });
});
