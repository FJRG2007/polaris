/**
 * Telling a refused password apart from a bad day, and leaving a refused
 * mailbox alone.
 *
 * The first half is what made the "your password changed" notice possible at
 * all. imapflow reports a refused LOGIN as "Command failed", with the server's
 * words beside the message rather than in it - and the old check read only the
 * message, so every IMAP refusal was filed as an unreachable server and retried
 * on every tick. Tried every twenty seconds with a password the server has
 * already refused, a provider locks the account.
 *
 * The second half is the backoff that replaces that loop: half of how long the
 * mailbox has been refused, between half an hour and a day, with no counter to
 * keep.
 */

import { describe, expect, it } from "vitest";
import {
    isCredentialRefusal,
    mayTryMailbox,
    refusedMailboxHref,
    refusedRetryDelayMs,
    REFUSED_RETRY_MAX_MS,
    REFUSED_RETRY_MIN_MS
} from "@/lib/mailbox/refusals";

/** What imapflow throws for a `NO` to LOGIN - see its commands/login.js. */
function imapRefusal(code: string, text: string) {
    return Object.assign(new Error("Command failed"), {
        responseStatus: "NO",
        serverResponseCode: code,
        authenticationFailed: true,
        response: `1 NO [${code}] ${text}`
    });
}

/** What nodemailer throws when AUTH is answered with an error. */
function smtpRefusal(responseCode: number, response: string) {
    return Object.assign(new Error(`Invalid login: ${response}`), {
        code: "EAUTH",
        responseCode,
        response
    });
}

describe("what counts as a refused credential", () => {
    it("reads imapflow's refusal, whose message says nothing", () => {
        expect(
            isCredentialRefusal(imapRefusal("AUTHENTICATIONFAILED", "Invalid credentials"))
        ).toBe(true);
        // No bracketed code, only the status: still a refusal.
        const bare = Object.assign(new Error("Command failed"), {
            responseStatus: "NO",
            authenticationFailed: true,
            response: "1 NO LOGIN failed."
        });
        expect(isCredentialRefusal(bare)).toBe(true);
    });

    it("does not call a server that cannot check right now a refusal", () => {
        expect(isCredentialRefusal(imapRefusal("UNAVAILABLE", "Try again later"))).toBe(false);
    });

    it("reads a reply whose code is not a refusal's by what it says", () => {
        expect(
            isCredentialRefusal(
                imapRefusal("ALERT", "Too many simultaneous connections. (Failure)")
            )
        ).toBe(false);
        expect(isCredentialRefusal(imapRefusal("ALERT", "Invalid credentials (Failure)"))).toBe(
            true
        );
        expect(
            isCredentialRefusal(
                imapRefusal("ALERT", "Please log in via your web browser (Failure)")
            )
        ).toBe(true);
    });

    it("does not call a socket that closed during LOGIN a refusal", () => {
        // imapflow stamps `authenticationFailed` on this too.
        const dropped = Object.assign(new Error("Connection not available"), {
            authenticationFailed: true,
            code: "NoConnection"
        });
        expect(isCredentialRefusal(dropped)).toBe(false);
        expect(
            isCredentialRefusal(
                Object.assign(new Error("Already logged out"), { authenticationFailed: true })
            )
        ).toBe(false);
    });

    it("reads an SMTP refusal and leaves a temporary one alone", () => {
        expect(
            isCredentialRefusal(smtpRefusal(535, "535 5.7.8 Username and Password not accepted"))
        ).toBe(true);
        expect(
            isCredentialRefusal(
                smtpRefusal(534, "534 5.7.9 Application-specific password required")
            )
        ).toBe(true);
        expect(
            isCredentialRefusal(smtpRefusal(454, "454 4.7.0 Temporary authentication failure"))
        ).toBe(false);
    });

    it("leaves the network, the DNS and a timeout as a retry", () => {
        expect(
            isCredentialRefusal(
                Object.assign(new Error("getaddrinfo ENOTFOUND imap.example.com"), {
                    code: "ENOTFOUND"
                })
            )
        ).toBe(false);
        expect(
            isCredentialRefusal(Object.assign(new Error("Socket timeout"), { code: "ETIMEOUT" }))
        ).toBe(false);
        expect(isCredentialRefusal(null)).toBe(false);
        expect(isCredentialRefusal("connect ECONNREFUSED")).toBe(false);
    });

    it("still reads a server that only says no in a sentence", () => {
        expect(isCredentialRefusal(new Error("AUTHENTICATE failed."))).toBe(true);
        expect(isCredentialRefusal("[AUTHENTICATIONFAILED] Invalid credentials (Failure)")).toBe(
            true
        );
    });
});

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-09-10T08:00:00Z");

function refused(lastOkAt: number, lastSyncAt: number) {
    return {
        state: "auth",
        lastOkAt: new Date(lastOkAt),
        lastSyncAt: new Date(lastSyncAt),
        createdAt: new Date(T0 - 30 * 24 * HOUR)
    };
}

describe("leaving a refused mailbox alone", () => {
    it("waits at least half an hour after the first refusal", () => {
        const account = refused(T0, T0 + 5 * 60 * 1000);
        expect(refusedRetryDelayMs(account)).toBe(REFUSED_RETRY_MIN_MS);
        expect(mayTryMailbox(account, { now: T0 + 20 * 60 * 1000 })).toBe(false);
        expect(mayTryMailbox(account, { now: T0 + 36 * 60 * 1000 })).toBe(true);
    });

    it("waits longer the longer it has been refused, up to a day", () => {
        expect(refusedRetryDelayMs(refused(T0, T0 + 6 * HOUR))).toBe(3 * HOUR);
        expect(refusedRetryDelayMs(refused(T0, T0 + 10 * 24 * HOUR))).toBe(REFUSED_RETRY_MAX_MS);
    });

    it("tries about ten times in the first day where it used to try every tick", () => {
        let account = refused(T0, T0 + 5 * 60 * 1000);
        let tries = 1;
        for (let now = T0; now < T0 + 24 * HOUR; now += 20 * 1000) {
            if (!mayTryMailbox(account, { now })) continue;
            tries += 1;
            account = refused(T0, now);
        }
        expect(tries).toBeGreaterThan(5);
        expect(tries).toBeLessThan(15);
    });

    it("lets its owner's own Check now through", () => {
        const account = refused(T0, T0 + 5 * 60 * 1000);
        expect(mayTryMailbox(account, { now: T0 + 6 * 60 * 1000, force: true })).toBe(true);
    });

    it("never holds back a mailbox that is not refused", () => {
        const working = { ...refused(T0, T0), state: "ok" };
        expect(mayTryMailbox(working, { now: T0 + 1 })).toBe(true);
        expect(mayTryMailbox({ ...working, state: "unreachable" }, { now: T0 + 1 })).toBe(true);
    });

    it("sends every notice to the same edit form", () => {
        expect(refusedMailboxHref("0190c1d2-0000-7000-8000-000000000001")).toBe(
            "/mail/settings/accounts?edit=0190c1d2-0000-7000-8000-000000000001"
        );
    });
});
