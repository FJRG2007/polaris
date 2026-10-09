/**
 * The server actions behind the account switcher: what reaches the page, what
 * they refuse, and what they write to the browser. The session work itself is
 * @polaris/auth's and is exercised there against a real auth instance; here it is
 * a fake holding a list of accounts, so each action's own decisions are what is
 * under test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ANA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";

interface FakeAccount {
    sessionId: string;
    token: string;
    userId: string;
    name: string;
    email: string;
    image: string | null;
    active: boolean;
}

let accounts: FakeAccount[] = [];
let cookieHeader = "";
let set: { name: string; value: string; options: Record<string, unknown> }[] = [];
let audits: Record<string, unknown>[] = [];
let notedOut: string[] = [];
let throttled = false;
let switchCalls: string[] = [];
let signOutCalls: string[] = [];
let revokeFails = false;

function account(sessionId: string, name: string, active: boolean): FakeAccount {
    return {
        sessionId,
        token: `token-${name}`,
        userId: `user-${name}`,
        name,
        email: `${name}@fixture.test`,
        image: null,
        active
    };
}

vi.mock("next/headers", () => ({
    headers: async () => new Headers({ cookie: cookieHeader }),
    cookies: async () => ({
        set: (name: string, value: string, options: Record<string, unknown>) => set.push({ name, value, options })
    })
}));

vi.mock("@/lib/auth", () => ({
    auth: { $context: Promise.resolve({ authCookies: { sessionToken: { name: "polaris.session_token" } } }) }
}));

vi.mock("@/lib/request-context", () => ({ clientIp: async () => "203.0.113.9" }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: !throttled, retryAfterMs: 0 })
}));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (event: Record<string, unknown>) => void audits.push(event)
}));
vi.mock("@/lib/session-sign-out", () => ({
    noteSignedOut: async (_userId: string, sessionId: string) => void notedOut.push(sessionId)
}));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string) => key
}));

vi.mock("@polaris/auth", async () => {
    const actual = await vi.importActual<typeof import("@polaris/auth")>("@polaris/auth");
    const issued = (name: string) => [{ name, value: "signed", options: { path: "/" } }];
    return {
        MAX_DEVICE_ACCOUNTS: actual.MAX_DEVICE_ACCOUNTS,
        deviceAccountRoom: actual.deviceAccountRoom,
        staleDeviceCookies: actual.staleDeviceCookies,
        listDeviceAccounts: async () => accounts,
        enrollDeviceAccount: async () => issued("polaris.session_token_multi-enrolled"),
        switchDeviceAccount: async (_auth: unknown, _headers: Headers, sessionId: string) => {
            switchCalls.push(sessionId);
            const found = accounts.find((entry) => entry.sessionId === sessionId && !entry.active);
            return found ? { account: found, cookies: issued("polaris.session_token") } : null;
        },
        signOutDeviceAccount: async (_auth: unknown, _headers: Headers, sessionId: string) => {
            signOutCalls.push(sessionId);
            if (revokeFails) return null;
            const found = accounts.find((entry) => entry.sessionId === sessionId);
            return found ? { account: found, cookies: issued("polaris.session_token") } : null;
        },
        signOutAllDeviceAccounts: async () => ({ accounts, cookies: issued("polaris.session_token") })
    };
});

const actions = await import("@/app/device-account-actions");

beforeEach(() => {
    accounts = [account(ANA, "ana", true), account(BEN, "ben", false)];
    cookieHeader = "";
    set = [];
    audits = [];
    notedOut = [];
    throttled = false;
    switchCalls = [];
    signOutCalls = [];
    revokeFails = false;
});

describe("deviceAccountsAction", () => {
    it("hands the page names and ids, never a session token", async () => {
        const result = await actions.deviceAccountsAction();
        expect(result.room).toBe(3);
        expect(result.max).toBe(5);
        expect(result.accounts.map((entry) => [entry.id, entry.name, entry.active])).toEqual([
            [ANA, "ana", true],
            [BEN, "ben", false]
        ]);
        expect(JSON.stringify(result)).not.toContain("token-");
    });

    it("clears the cookies of sessions that no longer exist", async () => {
        cookieHeader = "polaris.session_token_multi-token-ana=x; polaris.session_token_multi-gone=y";
        await actions.deviceAccountsAction();
        expect(set).toEqual([
            expect.objectContaining({ name: "polaris.session_token_multi-gone", value: "", options: expect.objectContaining({ maxAge: 0 }) })
        ]);
    });
});

describe("switchAccountAction", () => {
    it("refuses anything that is not a session id before looking", async () => {
        for (const bad of [undefined, null, 42, "ana", "' OR 1=1 --", { id: BEN }]) {
            expect((await actions.switchAccountAction(bad)).error).toBe("account.switcher.failed");
        }
        expect(switchCalls).toEqual([]);
    });

    it("switches to an account this browser holds and records it", async () => {
        expect(await actions.switchAccountAction(BEN)).toEqual({});
        expect(set.map((cookie) => cookie.name)).toEqual(["polaris.session_token"]);
        expect(audits).toEqual([
            expect.objectContaining({ actorId: "user-ben", action: "account.session.switched-to", targetId: BEN })
        ]);
    });

    it("refuses an account the browser does not hold, and writes nothing", async () => {
        const result = await actions.switchAccountAction("33333333-3333-4333-8333-333333333333");
        expect(result.error).toBe("account.switcher.failed");
        expect(set).toEqual([]);
        expect(audits).toEqual([]);
    });

    it("is throttled", async () => {
        throttled = true;
        expect((await actions.switchAccountAction(BEN)).error).toBe("account.switcher.tooFast");
        expect(switchCalls).toEqual([]);
    });
});

describe("prepareAddAccountAction", () => {
    it("enrols the active session so the next sign-in cannot replace it", async () => {
        expect(await actions.prepareAddAccountAction()).toEqual({});
        expect(set.map((cookie) => cookie.name)).toEqual(["polaris.session_token_multi-enrolled"]);
    });

    it("refuses a sixth account", async () => {
        accounts = ["a", "b", "c", "d", "e"].map((name, index) =>
            account(`0000000${index}-0000-4000-8000-000000000000`, name, index === 0)
        );
        expect((await actions.prepareAddAccountAction()).error).toBe("account.switcher.full");
        expect(set).toEqual([]);
    });
});

describe("signOutAccountAction", () => {
    it("signs the active account out by default and records it", async () => {
        expect(await actions.signOutAccountAction()).toEqual({});
        expect(signOutCalls).toEqual([ANA]);
        expect(notedOut).toEqual([ANA]);
    });

    it("signs a background account out without touching the active one", async () => {
        expect(await actions.signOutAccountAction(BEN)).toEqual({});
        expect(signOutCalls).toEqual([BEN]);
    });

    it("hands over to the next account when the active session is already gone", async () => {
        accounts = [account(BEN, "ben", false)];
        expect(await actions.signOutAccountAction()).toEqual({});
        expect(signOutCalls).toEqual([]);
        expect(switchCalls).toEqual([BEN]);
    });

    it("clears the session cookie when nothing is left", async () => {
        accounts = [];
        expect(await actions.signOutAccountAction()).toEqual({});
        expect(set).toEqual([
            expect.objectContaining({ name: "polaris.session_token", value: "", options: expect.objectContaining({ maxAge: 0 }) })
        ]);
    });

    it("says something went wrong, not that the account is gone, when the revoke fails", async () => {
        revokeFails = true;
        expect((await actions.signOutAccountAction()).error).toBe("account.switcher.error");
        expect(set).toEqual([]);
    });

    it("refuses an id this browser does not hold", async () => {
        const result = await actions.signOutAccountAction("33333333-3333-4333-8333-333333333333");
        expect(result.error).toBe("account.switcher.failed");
        expect(signOutCalls).toEqual([]);
    });
});

describe("signOutAllAccountsAction", () => {
    it("ends every account and records each", async () => {
        await actions.signOutAllAccountsAction();
        expect(notedOut.sort()).toEqual([ANA, BEN].sort());
        expect(set.map((cookie) => cookie.name)).toEqual(["polaris.session_token"]);
    });
});
