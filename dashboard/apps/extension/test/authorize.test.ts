/**
 * Being let in by a browser that is already inside the vault.
 *
 * This is a credential arriving over the network, so what is tested is the
 * refusing. A poll that is still waiting must read as waiting rather than as a
 * failure, or the popup gives up on the first ask; and an "approved" that arrives
 * without both halves - the token and the sealed key - must not be treated as a
 * sign-in, because a session that cannot decrypt anything looks signed in and is
 * worse than none.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimAuthorization, openAuthorization } from "../src/lib/protocol";

const BASE = "https://polaris.example/vault";

/** What the server answered, and what was asked of it. */
let asked: { url: string; body: string }[] = [];

function answering(status: number, body: unknown): void {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        asked.push({ url: String(url), body: String(init?.body ?? "") });
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => body
        } as Response;
    });
}

/** A token body as the server sends one, in the field names a client reads. */
const TOKEN = {
    access_token: "access",
    refresh_token: "refresh",
    expires_in: 3600,
    Key: "2.wrapped-key",
    PrivateKey: "2.wrapped-private",
    Kdf: 0,
    KdfIterations: 600000
};

beforeEach(() => {
    asked = [];
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("asking to be let in", () => {
    it("sends the public half and the device, and reads back the code", async () => {
        answering(200, {
            userCode: "BCDFGHJK",
            deviceCode: "secret",
            expiresAt: "2026-09-14T10:05:00.000Z",
            pollMs: 2000
        });
        const opened = await openAuthorization(BASE, {
            publicKey: "PUBLIC",
            device: { identifier: "extension-1", name: "Chrome extension" }
        });
        expect(opened?.userCode).toBe("BCDFGHJK");
        expect(opened?.deviceCode).toBe("secret");
        expect(asked[0]!.url).toContain("identity/connect/authorize");
        expect(asked[0]!.body).toContain("publicKey=PUBLIC");
        expect(asked[0]!.body).toContain("deviceIdentifier=extension-1");
    });

    it("comes back with nothing when the server will not answer", async () => {
        answering(500, {});
        expect(
            await openAuthorization(BASE, {
                publicKey: "PUBLIC",
                device: { identifier: "extension-1", name: "Chrome extension" }
            })
        ).toBeNull();
    });

    it("comes back with nothing when the answer is missing a code", async () => {
        answering(200, { userCode: "BCDFGHJK" });
        expect(
            await openAuthorization(BASE, {
                publicKey: "PUBLIC",
                device: { identifier: "extension-1", name: "Chrome extension" }
            })
        ).toBeNull();
    });
});

describe("collecting the approval", () => {
    it("reads waiting as waiting", async () => {
        // The ordinary case, and the one that must not look like a failure: a
        // hundred and fifty of these go out during one sign-in.
        answering(200, { status: "pending" });
        expect(await claimAuthorization(BASE, "secret")).toEqual({ status: "pending" });
    });

    it("carries a refusal through", async () => {
        answering(200, { status: "denied" });
        expect(await claimAuthorization(BASE, "secret")).toEqual({ status: "denied" });
    });

    it("hands over the token and the sealed key together", async () => {
        answering(200, { status: "approved", wrappedKey: "4.sealed", ...TOKEN });
        const claim = await claimAuthorization(BASE, "secret");
        expect(claim?.status).toBe("approved");
        if (claim?.status !== "approved") throw new Error("expected an approval");
        expect(claim.wrappedKey).toBe("4.sealed");
        expect(claim.token.accessToken).toBe("access");
        expect(claim.token.refreshToken).toBe("refresh");
    });

    it("refuses an approval with no sealed key", async () => {
        // Approved and unusable. Treating it as a sign-in would leave an extension
        // that says it is in and can read nothing.
        answering(200, { status: "approved", ...TOKEN });
        expect(await claimAuthorization(BASE, "secret")).toEqual({ status: "expired" });
    });

    it("refuses an approval with no token", async () => {
        answering(200, { status: "approved", wrappedKey: "4.sealed" });
        expect(await claimAuthorization(BASE, "secret")).toEqual({ status: "expired" });
    });

    it("treats a status it does not know as spent", async () => {
        // Anything but the three it understands, from a server of another version:
        // the safe reading is "this is over", which sends somebody back to ask
        // again rather than leaving a popup polling forever.
        answering(200, { status: "something-else" });
        expect(await claimAuthorization(BASE, "secret")).toEqual({ status: "expired" });
    });

    it("says nothing at all when the server cannot be reached", async () => {
        // Told apart from a refusal on purpose: the popper should keep waiting
        // through a dropped connection, and give up on a "no".
        vi.stubGlobal("fetch", async () => {
            throw new Error("offline");
        });
        expect(await claimAuthorization(BASE, "secret")).toBeNull();
    });
});
