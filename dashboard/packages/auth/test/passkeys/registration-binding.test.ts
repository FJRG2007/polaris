/**
 * Recording which address a new passkey was registered on. The plugin's row does
 * not carry it, so it is read back off the response the ceremony produced - and
 * nothing else must be mistaken for one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordRelyingParty } from "../../src/auth.js";

const update = vi.fn(async () => ({}));

vi.mock("@polaris/db", () => ({ prisma: { passkey: { update: (args: unknown) => update(args) } } }));

function registration(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
    });
}

function requestTo(path: string): Request {
    return new Request(`https://polaris.local${path}`, { method: "POST" });
}

beforeEach(() => update.mockClear());

describe("recordRelyingParty", () => {
    it("binds the created passkey to the address, without its port", async () => {
        const response = await recordRelyingParty(
            requestTo("/api/auth/passkey/verify-registration"),
            registration(200, { id: "passkey-1" }),
            "polaris.local:3000"
        );
        expect(update).toHaveBeenCalledWith({
            where: { id: "passkey-1" },
            data: { rpId: "polaris.local" }
        });
        // The ceremony's own answer has to reach the browser untouched.
        expect(await response.json()).toEqual({ id: "passkey-1" });
    });

    it("leaves every other endpoint alone", async () => {
        await recordRelyingParty(
            requestTo("/api/auth/passkey/verify-authentication"),
            registration(200, { id: "session-1" }),
            "polaris.local"
        );
        expect(update).not.toHaveBeenCalled();
    });

    it("records nothing when the ceremony failed", async () => {
        await recordRelyingParty(
            requestTo("/api/auth/passkey/verify-registration"),
            registration(400, { message: "failed to verify registration" }),
            "polaris.local"
        );
        expect(update).not.toHaveBeenCalled();
    });

    it("survives a response that is not the row it expected", async () => {
        const response = await recordRelyingParty(
            requestTo("/api/auth/passkey/verify-registration"),
            new Response("not json", { status: 200 }),
            "polaris.local"
        );
        expect(update).not.toHaveBeenCalled();
        expect(await response.text()).toBe("not json");
    });
});
