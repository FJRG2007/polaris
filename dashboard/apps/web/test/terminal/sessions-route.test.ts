/**
 * /api/deploy/terminal/sessions: gated like opening a shell on the server, the
 * caller's own sessions only, root sessions hidden once root is gone, and the
 * cap the administrator set rather than the sidecar's own.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const user = { id: "u1" };
let denied: Response | null = null;
let canShell = true;
let canRoot = true;
let sidecarDown = false;

const listTerminalSessions = vi.fn(async () => {
    if (sidecarDown) throw new SidecarUnavailable();
    return {
        sessions: [
            { id: "a", name: null, number: 1, mode: "ssh", attached: false },
            { id: "b", name: null, number: 2, mode: "ssh-root", attached: false }
        ],
        used: 2,
        cap: 10,
        idleMinutes: 60
    };
});
const changeTerminalSession = vi.fn(async () => true);

class SidecarUnavailable extends Error {}

vi.mock("@/lib/api-session", () => ({
    apiPermission: async () => denied ?? user
}));
vi.mock("@/lib/terminal-service", () => ({
    canOpenHostShell: async (_userId: string, _hostId: string, root?: boolean) =>
        root ? canShell && canRoot : canShell
}));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/terminal-session-cap", () => ({ terminalSessionCap: async () => 3 }));
vi.mock("@/lib/terminal-sessions", () => ({
    SidecarUnavailable,
    listTerminalSessions,
    changeTerminalSession
}));

const { GET, POST } = await import("../../src/app/api/deploy/terminal/sessions/route");

const ID = "6f1c1f0e-8a39-4c55-9a3e-2f0b3c9d1e2a";
const list = (hostId = "h1") =>
    GET(new Request(`http://app/api/deploy/terminal/sessions?hostId=${hostId}`));
const change = (body: unknown) =>
    POST(
        new Request("http://app/api/deploy/terminal/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        })
    );

beforeEach(() => {
    denied = null;
    canShell = true;
    canRoot = true;
    sidecarDown = false;
    listTerminalSessions.mockClear();
    changeTerminalSession.mockClear();
});

describe("terminal sessions route", () => {
    it("lists the caller's sessions with the administrator's cap", async () => {
        const res = await list();
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.cap).toBe(3);
        expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["a", "b"]);
        expect(listTerminalSessions).toHaveBeenCalledWith("u1", "h1");
    });

    it("hides root sessions once the server no longer grants root", async () => {
        canRoot = false;
        const body = await (await list()).json();
        expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(["a"]);
    });

    it("answers a server the caller cannot use as not found, and never asks the sidecar", async () => {
        canShell = false;
        expect((await list()).status).toBe(404);
        expect((await change({ action: "close", hostId: "h1", id: ID })).status).toBe(404);
        expect(listTerminalSessions).not.toHaveBeenCalled();
        expect(changeTerminalSession).not.toHaveBeenCalled();
    });

    it("passes the permission refusal through", async () => {
        denied = new Response(null, { status: 403 });
        expect((await list()).status).toBe(403);
    });

    it("validates the server and the change", async () => {
        expect((await GET(new Request("http://app/api/deploy/terminal/sessions"))).status).toBe(
            400
        );
        expect((await change({ action: "close", hostId: "h1", id: "not-a-uuid" })).status).toBe(
            400
        );
        expect((await change({ action: "kill", hostId: "h1", id: ID })).status).toBe(400);
        expect(
            (await change({ action: "rename", hostId: "h1", id: ID, name: "x".repeat(61) })).status
        ).toBe(400);
        expect(changeTerminalSession).not.toHaveBeenCalled();
    });

    it("scopes a change to the caller, and reports a session already gone", async () => {
        expect(
            (await change({ action: "rename", hostId: "h1", id: ID, name: " build " })).status
        ).toBe(200);
        expect(changeTerminalSession).toHaveBeenCalledWith("u1", {
            action: "rename",
            hostId: "h1",
            id: ID,
            name: "build"
        });
        changeTerminalSession.mockResolvedValueOnce(false);
        expect((await change({ action: "close", hostId: "h1", id: ID })).status).toBe(404);
    });

    it("says the sidecar is unavailable rather than failing", async () => {
        sidecarDown = true;
        const res = await list();
        expect(res.status).toBe(503);
        expect((await res.json()).error).toBe("errors.terminalSessionsUnavailable");
    });
});
