/**
 * Which address a session was opened on.
 *
 * Polaris answers on more than one name and the session cookie is host-only, so
 * one person signed in on the LAN name and on the public domain holds two
 * sessions that are identical in every other column. Two things have to hold for
 * the session list to be readable: the host is recorded against a session, and
 * listing an account's sessions never filters by it - every session the account
 * holds is the account's to see, whichever name it came in on.
 *
 * The header is client-supplied, so the parse is tested for what it refuses as
 * much as for what it keeps.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let requestHeaders = new Headers();
const sessionFindManyArgs: Record<string, unknown>[] = [];
let sessionRows: Record<string, unknown>[] = [];

vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

vi.mock("@polaris/db", () => ({
    prisma: {
        // The account's own rule about addresses, which the directory reads to
        // say what each session's "follow the account" currently amounts to.
        userSecurity: { findUnique: async () => null },
        session: {
            findMany: async (args: Record<string, unknown>) => {
                sessionFindManyArgs.push(args);
                return sessionRows;
            }
        }
    }
}));

vi.mock("@polaris/auth", () => ({ verifyQuickPin: async () => false }));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/network-service", () => ({ networkPublicIp: async () => "85.87.156.88" }));

const { clientHost } = await import("../../src/lib/request-context");
const { listUserSessions } = await import("../../src/lib/session-directory");

/** One Session row as the directory selects it, with its Polaris-side state. */
function sessionRow(id: string, state: Record<string, unknown> | null) {
    return {
        id,
        createdAt: new Date("2026-08-01T10:00:00Z"),
        expiresAt: new Date("2026-08-08T10:00:00Z"),
        ipAddress: "192.168.1.131",
        userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140",
        state
    };
}

beforeEach(() => {
    requestHeaders = new Headers();
    sessionFindManyArgs.length = 0;
    sessionRows = [];
});

describe("the address a request arrived on", () => {
    it("reads the host header", async () => {
        requestHeaders = new Headers({ host: "polaris.local" });
        expect(await clientHost()).toBe("polaris.local");
    });

    it("prefers what the proxy forwarded, since that is the name the browser used", async () => {
        requestHeaders = new Headers({ host: "polaris:3000", "x-forwarded-host": "polaris.example.com" });
        expect(await clientHost()).toBe("polaris.example.com");
    });

    it("drops the port, which is not part of the name", async () => {
        requestHeaders = new Headers({ host: "polaris.local:3000" });
        expect(await clientHost()).toBe("polaris.local");
    });

    it("lowercases, so one address is not recorded as two", async () => {
        requestHeaders = new Headers({ host: "Polaris.Local" });
        expect(await clientHost()).toBe("polaris.local");
    });

    it("keeps only the first of a forwarded chain", async () => {
        requestHeaders = new Headers({ "x-forwarded-host": "polaris.example.com, evil.test" });
        expect(await clientHost()).toBe("polaris.example.com");
    });

    it("refuses anything that is not shaped like a hostname", async () => {
        requestHeaders = new Headers({ host: "polaris.local/<script>" });
        expect(await clientHost()).toBeUndefined();
    });

    it("records nothing when the request carries no host at all", async () => {
        expect(await clientHost()).toBeUndefined();
    });
});

describe("listing an account's sessions", () => {
    it("asks only for the account's live sessions, never for one address", async () => {
        await listUserSessions("user-1", "session-1");
        const where = sessionFindManyArgs[0]?.where as Record<string, unknown>;
        expect(where.userId).toBe("user-1");
        expect(where).not.toHaveProperty("host");
        expect(Object.keys(where)).toEqual(["userId", "expiresAt"]);
    });

    it("returns every session, whichever name each was opened on", async () => {
        sessionRows = [
            sessionRow("session-1", { host: "polaris.local", lastSeenAt: new Date("2026-08-02T10:00:00Z") }),
            sessionRow("session-2", { host: "polaris.example.com", lastSeenAt: new Date("2026-08-02T11:00:00Z") })
        ];
        const sessions = await listUserSessions("user-1", "session-1");
        expect(sessions.map((session) => session.host)).toEqual(["polaris.local", "polaris.example.com"]);
        expect(sessions.filter((session) => session.current)).toHaveLength(1);
    });

    it("says nothing rather than guessing for a session opened before it was recorded", async () => {
        sessionRows = [sessionRow("session-1", { lastSeenAt: new Date("2026-08-02T10:00:00Z") })];
        expect((await listUserSessions("user-1", "session-1"))[0]?.host).toBeNull();
    });

    it("flags none as current when an administrator reads somebody else's list", async () => {
        sessionRows = [sessionRow("session-1", { host: "polaris.local", lastSeenAt: new Date() })];
        expect((await listUserSessions("user-2", ""))[0]?.current).toBe(false);
    });
});
