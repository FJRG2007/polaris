/**
 * An emailed sign-in link works only in the browser, and from the connection,
 * that asked for it - driven end to end through a real better-auth instance on
 * an in-memory store.
 *
 * Each browser is a cookie jar plus the address it arrives from. What is pinned:
 * the asking browser signs in; a different browser, a browser with no mark at
 * all, and the right browser on another connection are all sent to the page that
 * says where to open it; none of those refusals spends the link; and the email
 * says so before anybody finds out the hard way.
 */

import { betterAuth } from "better-auth";
import { beforeEach, describe, expect, it } from "vitest";
import { parseSetCookieHeader } from "better-auth/cookies";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
    EMAIL_LINK_ELSEWHERE_PATH,
    EMAIL_LINK_SAME_PLACE,
    emailLinkPlugin
} from "../../src/email-link.js";

const BASE = "http://localhost:3000";
const LOCAL = "http://polaris.local";
const EMAIL = "ada@fixture.test";
const SESSION_COOKIE = "polaris.session_token";
const HOME_IP = "203.0.113.10";
const OTHER_IP = "198.51.100.20";

type Db = Record<string, Record<string, unknown>[]>;

interface Sent {
    to: string;
    subject: string;
    text: string;
    html?: string;
}

let db: Db;
let sent: Sent[];
let auth: ReturnType<typeof betterAuth>;

/** A browser: the cookies it holds and the address it is seen from. */
class Browser {
    readonly jar = new Map<string, string>();

    constructor(public ip: string) {}

    headers(extra: Record<string, string> = {}): Headers {
        const headers = new Headers({ origin: BASE, "x-forwarded-for": this.ip, ...extra });
        if (this.jar.size > 0) {
            headers.set(
                "cookie",
                Array.from(this.jar, ([name, value]) => `${name}=${value}`).join("; ")
            );
        }
        return headers;
    }

    take(response: Response): void {
        for (const header of response.headers.getSetCookie()) {
            for (const [name, attributes] of parseSetCookieHeader(header)) {
                if (attributes["max-age"] === 0 || attributes.value === "") this.jar.delete(name);
                else this.jar.set(name, attributes.value);
            }
        }
    }
}

beforeEach(async () => {
    db = { user: [], session: [], account: [], verification: [] };
    sent = [];
    auth = betterAuth({
        baseURL: BASE,
        secret: "fixture-secret-value-0123456789abcdef",
        database: memoryAdapter(db),
        trustedOrigins: [LOCAL],
        emailAndPassword: { enabled: true },
        advanced: { cookiePrefix: "polaris" },
        plugins: [
            emailLinkPlugin({
                allowed: async () => true,
                send: async (message) => {
                    sent.push(message);
                    return {};
                }
            })
        ]
    });
    await (
        auth.api as unknown as {
            signUpEmail(input: {
                body: { email: string; password: string; name: string };
            }): Promise<unknown>;
        }
    ).signUpEmail({ body: { email: EMAIL, password: "Fixture-Password-123", name: "Ada" } });
});

async function askForLink(browser: Browser, extra: Record<string, string> = {}): Promise<string> {
    const headers = browser.headers(extra);
    headers.set("content-type", "application/json");
    const response = await auth.handler(
        new Request(`${BASE}/api/auth/sign-in/magic-link`, {
            method: "POST",
            headers,
            body: JSON.stringify({ email: EMAIL, callbackURL: "/home" })
        })
    );
    expect(response.status).toBe(200);
    browser.take(response);
    const message = sent.at(-1);
    if (!message) throw new Error("no link was sent");
    const url = message.text.match(/https?:\/\/\S+/)?.[0];
    if (!url) throw new Error("the message carries no link");
    return url;
}

async function open(browser: Browser, url: string): Promise<Response> {
    const response = await auth.handler(
        new Request(url, { method: "GET", headers: browser.headers() })
    );
    browser.take(response);
    return response;
}

function signedIn(browser: Browser): boolean {
    return browser.jar.has(SESSION_COOKIE);
}

describe("an emailed sign-in link", () => {
    it("signs in the browser that asked for it, from the same connection", async () => {
        const asker = new Browser(HOME_IP);
        const url = await askForLink(asker);
        const response = await open(asker, url);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(`${BASE}/home`);
        expect(signedIn(asker)).toBe(true);
    });

    it("refuses a browser holding a different mark", async () => {
        const asker = new Browser(HOME_IP);
        const url = await askForLink(asker);
        const other = new Browser(HOME_IP);
        await askForLink(other);
        const response = await open(other, url);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(EMAIL_LINK_ELSEWHERE_PATH);
        expect(signedIn(other)).toBe(false);
    });

    it("refuses a browser with no mark at all - another machine, a mail scanner", async () => {
        const url = await askForLink(new Browser(HOME_IP));
        const scanner = new Browser(HOME_IP);
        const response = await open(scanner, url);
        expect(response.headers.get("location")).toBe(EMAIL_LINK_ELSEWHERE_PATH);
        expect(signedIn(scanner)).toBe(false);
    });

    it("refuses the right browser on another connection", async () => {
        const asker = new Browser(HOME_IP);
        const url = await askForLink(asker);
        asker.ip = OTHER_IP;
        const response = await open(asker, url);
        expect(response.headers.get("location")).toBe(EMAIL_LINK_ELSEWHERE_PATH);
        expect(signedIn(asker)).toBe(false);
    });

    it("leaves the link unspent when it refuses, so it still works where it belongs", async () => {
        const asker = new Browser(HOME_IP);
        const url = await askForLink(asker);
        await open(new Browser(OTHER_IP), url);
        asker.ip = OTHER_IP;
        await open(asker, url);
        asker.ip = HOME_IP;
        const response = await open(asker, url);
        expect(response.headers.get("location")).toBe(`${BASE}/home`);
        expect(signedIn(asker)).toBe(true);
    });

    it("works once even where it belongs", async () => {
        const asker = new Browser(HOME_IP);
        const url = await askForLink(asker);
        await open(asker, url);
        asker.jar.delete(SESSION_COOKIE);
        const response = await open(asker, url);
        expect(response.headers.get("location")).toContain("error=INVALID_TOKEN");
        expect(signedIn(asker)).toBe(false);
    });

    it("keeps an earlier link good when the same browser asks again", async () => {
        const asker = new Browser(HOME_IP);
        const first = await askForLink(asker);
        await askForLink(asker);
        const response = await open(asker, first);
        expect(response.headers.get("location")).toBe(`${BASE}/home`);
    });

    it("answers a link that does not exist as before, not as one opened elsewhere", async () => {
        const response = await open(
            new Browser(HOME_IP),
            `${BASE}/api/auth/magic-link/verify?token=nothing-like-a-token&callbackURL=%2Fhome`
        );
        expect(response.headers.get("location")).toContain("error=INVALID_TOKEN");
    });

    it("points the link at the address it was asked from, landing page included", async () => {
        const asker = new Browser(HOME_IP);
        const url = await askForLink(asker, {
            origin: LOCAL,
            "x-forwarded-host": "polaris.local",
            "x-forwarded-proto": "http"
        });
        expect(url.startsWith(`${LOCAL}/api/auth/magic-link/verify?`)).toBe(true);
        expect(new URL(url).searchParams.get("callbackURL")).toBe(`${LOCAL}/home`);
        const response = await open(asker, url);
        expect(response.headers.get("location")).toBe(`${LOCAL}/home`);
        expect(signedIn(asker)).toBe(true);
    });

    it("never points the link at an address this deployment does not trust", async () => {
        const url = await askForLink(new Browser(HOME_IP), {
            "x-forwarded-host": "evil.example",
            "x-forwarded-proto": "https"
        });
        expect(url.startsWith(`${BASE}/api/auth/magic-link/verify?`)).toBe(true);
    });

    it("marks the asking browser with a short-lived, script-proof cookie", async () => {
        const headers = new Browser(HOME_IP).headers();
        headers.set("content-type", "application/json");
        const response = await auth.handler(
            new Request(`${BASE}/api/auth/sign-in/magic-link`, {
                method: "POST",
                headers,
                body: JSON.stringify({ email: EMAIL })
            })
        );
        const cookie = response.headers
            .getSetCookie()
            .find((header) => header.startsWith("polaris.link_binding="));
        expect(cookie).toBeDefined();
        expect(cookie).toMatch(/HttpOnly/i);
        expect(cookie).toMatch(/SameSite=Lax/i);
        expect(cookie).toMatch(/Max-Age=600/);
        // Only a digest is stored; the cookie's value appears nowhere in the store.
        const value = cookie?.split(";")[0]?.split("=")[1] ?? "";
        expect(JSON.stringify(db.verification)).not.toContain(value);
    });

    it("says in the email where the link has to be opened", async () => {
        await askForLink(new Browser(HOME_IP));
        const message = sent.at(-1);
        expect(EMAIL_LINK_SAME_PLACE).toBe(
            "Open this link on the same device and internet connection you used to ask for it."
        );
        expect(message?.text).toContain(EMAIL_LINK_SAME_PLACE);
        expect(message?.html).toContain(EMAIL_LINK_SAME_PLACE);
    });
});
