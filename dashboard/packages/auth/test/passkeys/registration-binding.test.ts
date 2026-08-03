/**
 * Recording where a new passkey came from: the address it was registered on, the
 * browser that created it, and the address that request arrived from. The
 * plugin's row carries none of them, so all three are read off the ceremony as it
 * goes past - and nothing else must be mistaken for one.
 */

import { recordPasskeyOrigin } from "../../src/auth.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.fn(async () => ({}));

vi.mock("@polaris/db", () => ({ prisma: { passkey: { update: (args: unknown) => update(args) } } }));

function registration(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
    });
}

function requestTo(path: string, headers?: Record<string, string>): Request {
    return new Request(`https://polaris.local${path}`, { method: "POST", headers });
}

/** What the update was asked to write, for the tests that only care about one
 *  column of it. */
function written(): Record<string, unknown> {
    const [args] = update.mock.calls[0] as [{ data: Record<string, unknown> }];
    return args.data;
}

beforeEach(() => update.mockClear());

describe("recordPasskeyOrigin", () => {
    it("binds the created passkey to the address, without its port", async () => {
        const response = await recordPasskeyOrigin(
            requestTo("/api/auth/passkey/verify-registration"),
            registration(200, { id: "passkey-1" }),
            "polaris.local:3000"
        );
        expect(written()).toMatchObject({ rpId: "polaris.local", userAgent: null });
        // The ceremony's own answer has to reach the browser untouched.
        expect(await response.json()).toEqual({ id: "passkey-1" });
    });

    it("records the browser that created it, so it can be shown beside that device", async () => {
        await recordPasskeyOrigin(
            requestTo("/api/auth/passkey/verify-registration", {
                "user-agent": "Mozilla/5.0 (Macintosh) Safari/605",
                "sec-ch-ua": '"Chromium";v="131", "Brave";v="131"'
            }),
            registration(200, { id: "passkey-1" }),
            "polaris.local"
        );
        expect(written()).toMatchObject({
            rpId: "polaris.local",
            userAgent: "Mozilla/5.0 (Macintosh) Safari/605",
            // The only place a browser that reports itself as Chrome says which
            // one it really is.
            userAgentBrands: '"Chromium";v="131", "Brave";v="131"'
        });
    });

    it("records the address the registration came from", async () => {
        await recordPasskeyOrigin(
            requestTo("/api/auth/passkey/verify-registration", { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }),
            registration(200, { id: "passkey-1" }),
            "polaris.local"
        );
        expect(written()).toMatchObject({ ip: "203.0.113.7" });
    });

    it("stores the name the uniqueness rule was applied to", async () => {
        // better-auth keeps what the browser sent verbatim; the ceremony compared
        // a trimmed form. Writing the trimmed one back keeps the stored name and
        // the checked name the same string.
        await recordPasskeyOrigin(
            requestTo("/api/auth/passkey/verify-registration"),
            registration(200, { id: "passkey-1", name: "  Work laptop " }),
            "polaris.local"
        );
        expect(written()).toMatchObject({ name: "Work laptop" });
    });

    it("leaves the stored name alone when the ceremony returned none", async () => {
        await recordPasskeyOrigin(
            requestTo("/api/auth/passkey/verify-registration"),
            registration(200, { id: "passkey-1" }),
            "polaris.local"
        );
        expect(written()).not.toHaveProperty("name");
    });

    it("leaves every other endpoint alone", async () => {
        await recordPasskeyOrigin(
            requestTo("/api/auth/passkey/verify-authentication"),
            registration(200, { id: "session-1" }),
            "polaris.local"
        );
        expect(update).not.toHaveBeenCalled();
    });

    it("records nothing when the ceremony failed", async () => {
        await recordPasskeyOrigin(
            requestTo("/api/auth/passkey/verify-registration"),
            registration(400, { message: "failed to verify registration" }),
            "polaris.local"
        );
        expect(update).not.toHaveBeenCalled();
    });

    it("survives a response that is not the row it expected", async () => {
        const response = await recordPasskeyOrigin(
            requestTo("/api/auth/passkey/verify-registration"),
            new Response("not json", { status: 200 }),
            "polaris.local"
        );
        expect(update).not.toHaveBeenCalled();
        expect(await response.text()).toBe("not json");
    });
});
