/**
 * Recording where a new passkey came from: the address it was registered on and
 * the browser that created it. The plugin's row carries neither, so both are
 * read off the ceremony as it goes past - and nothing else must be mistaken for
 * one.
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

function requestTo(path: string, userAgent?: string): Request {
    return new Request(`https://polaris.local${path}`, {
        method: "POST",
        headers: userAgent ? { "user-agent": userAgent } : undefined
    });
}

beforeEach(() => update.mockClear());

describe("recordPasskeyOrigin", () => {
    it("binds the created passkey to the address, without its port", async () => {
        const response = await recordPasskeyOrigin(
            requestTo("/api/auth/passkey/verify-registration"),
            registration(200, { id: "passkey-1" }),
            "polaris.local:3000"
        );
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "passkey-1" },
                data: expect.objectContaining({ rpId: "polaris.local" })
            })
        );
        // The ceremony's own answer has to reach the browser untouched.
        expect(await response.json()).toEqual({ id: "passkey-1" });
    });

    it("records the browser that created it, so it can be shown beside that device", async () => {
        await recordPasskeyOrigin(
            requestTo("/api/auth/passkey/verify-registration", "Mozilla/5.0 (Macintosh) Safari/605"),
            registration(200, { id: "passkey-1" }),
            "polaris.local"
        );
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ userAgent: "Mozilla/5.0 (Macintosh) Safari/605" })
            })
        );
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
