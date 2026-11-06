/**
 * The sidecar's wiring around the session registry: how a socket attaches to a
 * server shell (new, resumed, refused at the cap, ended) and the web app's
 * loopback calls that list, rename and close a user's sessions.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
    attachServerShell,
    createSessionRegistry,
    sessionsRequest
} from "../../terminal-sessions.mjs";

const OPEN = 1;
const CLOSED = 3;

class FakeSocket extends EventEmitter {
    readonly OPEN = OPEN;
    readyState = OPEN;
    sent: string[] = [];
    closes: Array<[number, string]> = [];
    send(chunk: unknown): void {
        this.sent.push(String(chunk));
    }
    close(code: number, reason: string): void {
        this.closes.push([code, reason]);
        this.readyState = CLOSED;
    }
}

class FakeShell extends EventEmitter {
    written: string[] = [];
    closed = false;
    write(data: unknown): void {
        this.written.push(String(data));
    }
}

function opener() {
    const shells: FakeShell[] = [];
    const open = async () => {
        const stream = new FakeShell();
        shells.push(stream);
        return {
            stream,
            resize: () => undefined,
            close: () => {
                stream.closed = true;
            }
        };
    };
    return { shells, open };
}

const ticket = (extra: Record<string, unknown> = {}) => ({
    userId: "u1",
    targetId: "h1",
    mode: "ssh",
    containerRef: "",
    ...extra
});

describe("attachServerShell", () => {
    it("opens a new session, names it first, and keeps it running after the socket closes", async () => {
        const registry = createSessionRegistry();
        const { shells, open } = opener();
        const ws = new FakeSocket();
        await attachServerShell(registry, open, ticket(), ws);

        const [listed] = registry.list("u1", "h1");
        expect(JSON.parse(ws.sent[0])).toEqual({ session: { id: listed.id, number: 1 } });
        ws.emit("message", Buffer.from("ls\r"), false);
        expect(shells[0].written).toEqual(["ls\r"]);

        ws.emit("close");
        expect(shells[0].closed).toBe(false);
        expect(registry.list("u1", "h1")[0].attached).toBe(false);
    });

    it("resumes the named session and replays its scrollback without dialling again", async () => {
        const registry = createSessionRegistry();
        const { shells, open } = opener();
        const first = new FakeSocket();
        await attachServerShell(registry, open, ticket(), first);
        const id = registry.list("u1", "h1")[0].id;
        shells[0].emit("data", Buffer.from("done\r\n"));
        first.emit("close");

        const again = new FakeSocket();
        await attachServerShell(registry, open, ticket({ containerRef: id }), again);
        expect(shells).toHaveLength(1);
        expect(JSON.parse(again.sent[0]).session.id).toBe(id);
        expect(again.sent[1]).toBe("done\r\n");
    });

    it("answers a foreign or finished id as ended", async () => {
        const registry = createSessionRegistry();
        const { shells, open } = opener();
        await attachServerShell(registry, open, ticket(), new FakeSocket());
        const id = registry.list("u1", "h1")[0].id;

        for (const other of [
            ticket({ userId: "u2", containerRef: id }),
            ticket({ targetId: "h2", containerRef: id }),
            ticket({ mode: "ssh-root", containerRef: id }),
            ticket({ containerRef: "00000000-0000-4000-8000-000000000000" })
        ]) {
            const ws = new FakeSocket();
            await attachServerShell(registry, open, other, ws);
            expect(ws.closes).toEqual([[4006, "session ended"]]);
            expect(ws.sent).toEqual([]);
        }
        expect(shells).toHaveLength(1);
    });

    it("refuses a new session past the cap the ticket carries", async () => {
        const registry = createSessionRegistry();
        const { shells, open } = opener();
        await attachServerShell(registry, open, ticket({ sessionCap: 1 }), new FakeSocket());
        const ws = new FakeSocket();
        await attachServerShell(registry, open, ticket({ sessionCap: 1 }), ws);
        expect(ws.closes).toEqual([[4005, "session limit reached"]]);
        expect(shells).toHaveLength(1);
    });

    it("checks the cap again after dialling, and closes what it dialled", async () => {
        const registry = createSessionRegistry();
        const { shells, open } = opener();
        const ws = new FakeSocket();
        const racing = async () => {
            const opened = await open();
            // Another tab finished opening while this one was dialling.
            await attachServerShell(registry, open, ticket({ sessionCap: 1 }), new FakeSocket());
            return opened;
        };
        await attachServerShell(registry, racing, ticket({ sessionCap: 1 }), ws);
        expect(ws.closes).toEqual([[4005, "session limit reached"]]);
        expect(shells[0].closed).toBe(true);
        expect(registry.count("u1")).toBe(1);
    });

    it("drops what it dialled when the socket went meanwhile", async () => {
        const registry = createSessionRegistry();
        const { shells, open } = opener();
        const ws = new FakeSocket();
        const slow = async () => {
            const opened = await open();
            ws.readyState = CLOSED;
            return opened;
        };
        await attachServerShell(registry, slow, ticket(), ws);
        expect(shells[0].closed).toBe(true);
        expect(registry.count("u1")).toBe(0);
    });
});

describe("sessionsRequest", () => {
    const KEY = "internal-secret";
    const url = (path: string) => new URL(path, "http://sidecar");
    const get = (registry: ReturnType<typeof createSessionRegistry>, query: string, key = KEY) =>
        sessionsRequest(registry, KEY, {
            method: "GET",
            url: url(`/internal/terminal-sessions?${query}`),
            key,
            readBody: async () => ""
        });
    const post = (registry: ReturnType<typeof createSessionRegistry>, body: unknown, key = KEY) =>
        sessionsRequest(registry, KEY, {
            method: "POST",
            url: url("/internal/terminal-sessions"),
            key,
            readBody: async () => JSON.stringify(body)
        });

    async function seeded() {
        const registry = createSessionRegistry({ cap: 4, idleMs: 30 * 60_000 });
        const { open } = opener();
        await attachServerShell(registry, open, ticket(), new FakeSocket());
        await attachServerShell(registry, open, ticket({ userId: "u2" }), new FakeSocket());
        return registry;
    }

    it("refuses without the shared key, and when no key is configured", async () => {
        const registry = await seeded();
        expect((await get(registry, "userId=u1&hostId=h1", "wrong")).status).toBe(403);
        expect((await get(registry, "userId=u1&hostId=h1", "")).status).toBe(403);
        const unset = await sessionsRequest(registry, "", {
            method: "GET",
            url: url("/internal/terminal-sessions?userId=u1&hostId=h1"),
            key: "",
            readBody: async () => ""
        });
        expect(unset.status).toBe(403);
    });

    it("lists only the caller's sessions on that server", async () => {
        const registry = await seeded();
        const { status, body } = await get(registry, "userId=u1&hostId=h1");
        expect(status).toBe(200);
        expect(body).toMatchObject({ used: 1, cap: 4, idleMinutes: 30 });
        expect((body as { sessions: unknown[] }).sessions).toHaveLength(1);
        expect((await get(registry, "userId=u1")).status).toBe(400);
    });

    it("renames and closes only the caller's own session", async () => {
        const registry = await seeded();
        const mine = registry.list("u1", "h1")[0].id;
        const theirs = registry.list("u2", "h1")[0].id;

        const foreign = await post(registry, {
            action: "close",
            userId: "u1",
            hostId: "h1",
            id: theirs
        });
        expect(foreign).toEqual({ status: 404, body: { ok: false } });
        expect(registry.count("u2")).toBe(1);

        const renamed = await post(registry, {
            action: "rename",
            userId: "u1",
            hostId: "h1",
            id: mine,
            name: "build"
        });
        expect(renamed.status).toBe(200);
        expect(registry.list("u1", "h1")[0].name).toBe("build");

        const wrongHost = await post(registry, {
            action: "close",
            userId: "u1",
            hostId: "h2",
            id: mine
        });
        expect(wrongHost.status).toBe(404);
        expect(
            (await post(registry, { action: "close", userId: "u1", hostId: "h1", id: mine })).status
        ).toBe(200);
        expect(registry.count("u1")).toBe(0);
    });

    it("rejects a malformed body or an unknown action", async () => {
        const registry = await seeded();
        const bad = await sessionsRequest(registry, KEY, {
            method: "POST",
            url: url("/internal/terminal-sessions"),
            key: KEY,
            readBody: async () => "{not json"
        });
        expect(bad.status).toBe(400);
        const id = registry.list("u1", "h1")[0].id;
        expect(
            (await post(registry, { action: "kill", userId: "u1", hostId: "h1", id })).status
        ).toBe(400);
        expect((await post(registry, { action: "close", hostId: "h1", id })).status).toBe(400);
    });
});
