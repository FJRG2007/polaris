/**
 * Several accounts on one browser, driven end to end through a real better-auth
 * instance on an in-memory store: signing in adds an account without signing the
 * first one out, switching moves the session cookie, signing one out leaves the
 * rest, the ceiling holds, and nothing about one browser's accounts can be
 * reached from another.
 *
 * The browser is a cookie jar. Sign-ins go over HTTP, as the sign-in page sends
 * them; everything else goes through the helpers the server actions call.
 */

import { betterAuth } from "better-auth";
import type { Auth } from "../../src/auth.js";
import { beforeEach, describe, expect, it } from "vitest";
import { parseSetCookieHeader } from "better-auth/cookies";
import { memoryAdapter } from "better-auth/adapters/memory";
import type { IssuedCookie } from "../../src/device-login.js";
import {
    MAX_DEVICE_ACCOUNTS,
    deviceAccountRoom,
    deviceAccountsPlugin,
    enrollDeviceAccount,
    listDeviceAccounts,
    signOutAllDeviceAccounts,
    signOutDeviceAccount,
    staleDeviceCookies,
    switchDeviceAccount
} from "../../src/device-accounts.js";

const BASE = "http://localhost:3000";
const PASSWORD = "Fixture-Password-123";
const SESSION_COOKIE = "polaris.session_token";

type Db = Record<string, Record<string, unknown>[]>;

let db: Db;
let auth: Auth;

function createTestAuth(): Auth {
    db = { user: [], session: [], account: [], verification: [] };
    return betterAuth({
        baseURL: BASE,
        secret: "fixture-secret-value-0123456789abcdef",
        database: memoryAdapter(db),
        emailAndPassword: { enabled: true },
        advanced: { cookiePrefix: "polaris" },
        plugins: [deviceAccountsPlugin()]
    }) as unknown as Auth;
}

/** A browser: the cookies it holds. */
class Browser {
    readonly jar = new Map<string, string>();

    headers(): Headers {
        const headers = new Headers({ origin: BASE });
        if (this.jar.size > 0) {
            headers.set(
                "cookie",
                Array.from(this.jar, ([name, value]) => `${name}=${value}`).join("; ")
            );
        }
        return headers;
    }

    take(cookies: readonly IssuedCookie[]): void {
        for (const cookie of cookies) {
            if (cookie.options.maxAge === 0 || cookie.value === "") this.jar.delete(cookie.name);
            else this.jar.set(cookie.name, cookie.value);
        }
    }

    takeResponse(response: Response): void {
        for (const header of response.headers.getSetCookie()) {
            for (const [name, attributes] of parseSetCookieHeader(header)) {
                if (attributes["max-age"] === 0 || attributes.value === "") this.jar.delete(name);
                else this.jar.set(name, attributes.value);
            }
        }
    }

    multiCookies(): string[] {
        return Array.from(this.jar.keys()).filter((name) => name.includes("_multi-"));
    }
}

async function signUp(name: string): Promise<string> {
    const email = `${name}@fixture.test`;
    const result = await (auth.api as unknown as {
        signUpEmail(input: { body: { email: string; password: string; name: string } }): Promise<{ user: { id: string } }>;
    }).signUpEmail({ body: { email, password: PASSWORD, name } });
    return result.user.id;
}

async function signIn(browser: Browser, name: string): Promise<Response> {
    const response = await auth.handler(
        new Request(`${BASE}/api/auth/sign-in/email`, {
            method: "POST",
            headers: (() => {
                const headers = browser.headers();
                headers.set("content-type", "application/json");
                return headers;
            })(),
            body: JSON.stringify({ email: `${name}@fixture.test`, password: PASSWORD })
        })
    );
    expect(response.status).toBe(200);
    browser.takeResponse(response);
    return response;
}

async function activeUserId(browser: Browser): Promise<string | null> {
    const session = await auth.api.getSession({ headers: browser.headers(), query: { disableRefresh: true } });
    return session?.user.id ?? null;
}

const ids: Record<string, string> = {};

beforeEach(async () => {
    auth = createTestAuth();
    for (const name of ["ana", "ben", "cai", "dan", "eva", "fay"]) ids[name] = await signUp(name);
});

describe("adding an account", () => {
    it("keeps the first account signed in and makes the new one active", async () => {
        const browser = new Browser();
        await signIn(browser, "ana");
        await signIn(browser, "ben");

        const accounts = await listDeviceAccounts(auth, browser.headers());
        expect(accounts.map((account) => [account.name, account.active])).toEqual([
            ["ben", true],
            ["ana", false]
        ]);
        expect(await activeUserId(browser)).toBe(ids.ben);
    });

    it("replaces the account's own older session instead of listing it twice", async () => {
        const browser = new Browser();
        await signIn(browser, "ana");
        await signIn(browser, "ben");
        await signIn(browser, "ana");

        const accounts = await listDeviceAccounts(auth, browser.headers());
        expect(accounts.map((account) => account.name)).toEqual(["ana", "ben"]);
        expect(db.session.filter((row) => row.userId === ids.ana)).toHaveLength(2); // one from sign-up
    });

    it("enrols a session opened before accounts could be added, so the next sign-in cannot push it out", async () => {
        const browser = new Browser();
        await signIn(browser, "ana");
        // What a browser signed in before this existed holds: the session cookie alone.
        for (const name of browser.multiCookies()) browser.jar.delete(name);

        browser.take(await enrollDeviceAccount(auth, browser.headers()));
        expect(browser.multiCookies()).toHaveLength(1);

        await signIn(browser, "ben");
        const accounts = await listDeviceAccounts(auth, browser.headers());
        expect(accounts.map((account) => account.name).sort()).toEqual(["ana", "ben"]);
    });
});

describe("switching", () => {
    it("moves the browser's session to the chosen account", async () => {
        const browser = new Browser();
        await signIn(browser, "ana");
        await signIn(browser, "ben");
        const ana = (await listDeviceAccounts(auth, browser.headers())).find((account) => account.name === "ana");

        const switched = await switchDeviceAccount(auth, browser.headers(), ana!.sessionId);
        expect(switched?.account.userId).toBe(ids.ana);
        browser.take(switched!.cookies);

        expect(await activeUserId(browser)).toBe(ids.ana);
        const accounts = await listDeviceAccounts(auth, browser.headers());
        expect(accounts.map((account) => [account.name, account.active])).toEqual([
            ["ana", true],
            ["ben", false]
        ]);
    });

    it("refuses the account already active and an id this browser does not hold", async () => {
        const browser = new Browser();
        await signIn(browser, "ana");
        await signIn(browser, "ben");
        const [active] = await listDeviceAccounts(auth, browser.headers());

        expect(await switchDeviceAccount(auth, browser.headers(), active!.sessionId)).toBeNull();
        expect(await switchDeviceAccount(auth, browser.headers(), crypto.randomUUID())).toBeNull();
    });
});

describe("signing out", () => {
    it("ends the active account only and hands the browser to the next", async () => {
        const browser = new Browser();
        await signIn(browser, "ana");
        await signIn(browser, "ben");
        const [ben] = await listDeviceAccounts(auth, browser.headers());

        const ended = await signOutDeviceAccount(auth, browser.headers(), ben!.sessionId);
        browser.take(ended!.cookies);

        expect(await activeUserId(browser)).toBe(ids.ana);
        expect(db.session.some((row) => row.id === ben!.sessionId)).toBe(false);
        expect((await listDeviceAccounts(auth, browser.headers())).map((account) => account.name)).toEqual(["ana"]);
    });

    it("ends an account in the background without touching the active one", async () => {
        const browser = new Browser();
        await signIn(browser, "ana");
        await signIn(browser, "ben");
        const ana = (await listDeviceAccounts(auth, browser.headers())).find((account) => account.name === "ana");

        browser.take((await signOutDeviceAccount(auth, browser.headers(), ana!.sessionId))!.cookies);

        expect(await activeUserId(browser)).toBe(ids.ben);
        expect((await listDeviceAccounts(auth, browser.headers())).map((account) => account.name)).toEqual(["ben"]);
    });

    it("signs the last account out completely, even one that predates enrolment", async () => {
        const browser = new Browser();
        await signIn(browser, "ana");
        for (const name of browser.multiCookies()) browser.jar.delete(name);
        const [ana] = await listDeviceAccounts(auth, browser.headers());

        browser.take((await signOutDeviceAccount(auth, browser.headers(), ana!.sessionId))!.cookies);

        expect(await activeUserId(browser)).toBeNull();
        expect(db.session.some((row) => row.id === ana!.sessionId)).toBe(false);
    });

    it("signs every account out at once", async () => {
        const browser = new Browser();
        await signIn(browser, "ana");
        await signIn(browser, "ben");
        const before = await listDeviceAccounts(auth, browser.headers());

        const ended = await signOutAllDeviceAccounts(auth, browser.headers());
        browser.take(ended!.cookies);

        expect(ended!.accounts).toHaveLength(2);
        expect(await activeUserId(browser)).toBeNull();
        expect(await listDeviceAccounts(auth, browser.headers())).toEqual([]);
        for (const account of before) expect(db.session.some((row) => row.id === account.sessionId)).toBe(false);
    });
});

describe("the ceiling", () => {
    it("is five accounts per browser", async () => {
        expect(MAX_DEVICE_ACCOUNTS).toBe(5);
        expect(deviceAccountRoom(0)).toBe(5);
        expect(deviceAccountRoom(4)).toBe(1);
        expect(deviceAccountRoom(5)).toBe(0);
        expect(deviceAccountRoom(7)).toBe(0);
    });

    it("never remembers a sixth account alongside five", async () => {
        const browser = new Browser();
        for (const name of ["ana", "ben", "cai", "dan", "eva"]) await signIn(browser, name);
        expect(await listDeviceAccounts(auth, browser.headers())).toHaveLength(5);

        await signIn(browser, "fay");
        expect(browser.multiCookies()).toHaveLength(5);
    });
});

describe("isolation between browsers", () => {
    it("lists only the accounts whose sessions this browser holds", async () => {
        const first = new Browser();
        await signIn(first, "ana");
        await signIn(first, "ben");
        const second = new Browser();
        await signIn(second, "cai");

        expect((await listDeviceAccounts(auth, second.headers())).map((account) => account.name)).toEqual(["cai"]);
    });

    it("cannot switch to or sign out another browser's account", async () => {
        const first = new Browser();
        await signIn(first, "ana");
        await signIn(first, "ben");
        const ana = (await listDeviceAccounts(auth, first.headers())).find((account) => account.name === "ana");
        const second = new Browser();
        await signIn(second, "cai");

        expect(await switchDeviceAccount(auth, second.headers(), ana!.sessionId)).toBeNull();
        expect(await signOutDeviceAccount(auth, second.headers(), ana!.sessionId)).toBeNull();
        expect(await activeUserId(second)).toBe(ids.cai);
        expect(db.session.some((row) => row.id === ana!.sessionId)).toBe(true);
    });

    it("ignores a session cookie that better-auth did not sign", async () => {
        const browser = new Browser();
        await signIn(browser, "cai");
        const victim = db.session.find((row) => row.userId === ids.ana) as { token: string };
        browser.jar.set(`${SESSION_COOKIE}_multi-${victim.token.toLowerCase()}`, victim.token);

        expect((await listDeviceAccounts(auth, browser.headers())).map((account) => account.name)).toEqual(["cai"]);
    });

    it("answers nothing when the endpoints are called over HTTP", async () => {
        const browser = new Browser();
        await signIn(browser, "ana");
        for (const path of ["/multi-session/list-device-sessions", "/polaris/device-accounts/enroll"]) {
            const response = await auth.handler(
                new Request(`${BASE}/api/auth${path}`, {
                    method: path.endsWith("enroll") ? "POST" : "GET",
                    headers: browser.headers()
                })
            );
            expect(response.status).toBe(404);
        }
    });
});

describe("staleDeviceCookies", () => {
    it("names the extra cookies whose session is gone", () => {
        const header = [
            `${SESSION_COOKIE}=live.sig`,
            `${SESSION_COOKIE}_multi-abc=abc.sig`,
            `__Secure-${SESSION_COOKIE}_multi-gone=gone.sig`,
            "other=1"
        ].join("; ");
        expect(staleDeviceCookies(header, ["ABC"])).toEqual([`__Secure-${SESSION_COOKIE}_multi-gone`]);
        expect(staleDeviceCookies(null, [])).toEqual([]);
    });
});
