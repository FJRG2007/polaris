/**
 * The pass a picture in a message carries.
 *
 * A message is drawn in a sandboxed frame with no same-origin privileges, and a
 * frame like that is a different site as far as cookies go: the session cookie
 * is not sent with anything it asks for. Measured, not assumed - an image
 * requested from inside one arrives carrying `SameSite=None` cookies and nothing
 * else, and Polaris' session cookie is not one of those.
 *
 * So the address carries its own authority. These are the properties that has to
 * have to be worth anything: it round-trips, it cannot be moved onto another
 * message or another picture, it cannot be forged, and it stops working.
 *
 * And the one thing the route itself has to get right: a picture it will not
 * pass on is answered with nothing at all. `new Response("", { status: 204 })`
 * throws - a 204 carries no body, and an empty string is a body - so every
 * blocked image raised "Invalid response status code 204" in production instead
 * of quietly not drawing.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@polaris/config";

// The placeholder environment a production build runs under fills everything
// else in; the secret is the only value this file actually uses.
process.env.NEXT_PHASE = "phase-production-build";
process.env.POLARIS_AUTH_SECRET = "a-secret-that-is-long-enough-to-be-one";

let imageUrl: typeof import("@/lib/mailbox/image-token").imageUrl;
let readImagePass: typeof import("@/lib/mailbox/image-token").readImagePass;

beforeAll(async () => {
    resetEnvCache();
    ({ imageUrl, readImagePass } = await import("@/lib/mailbox/image-token"));
});

/** The token out of an address the reader would have been given. */
function tokenOf(url: string): string {
    return url.split("/").at(-1)!;
}

describe("a signed picture address", () => {
    it("says which message, which picture and who for", () => {
        const url = imageUrl({ messageId: "msg_1", index: 3, userId: "usr_7" });
        expect(url.startsWith("/api/mail/image/msg_1/3/")).toBe(true);
        expect(readImagePass(tokenOf(url), "msg_1", 3)).toEqual({
            messageId: "msg_1",
            index: 3,
            userId: "usr_7"
        });
    });

    it("cannot be moved onto another message", () => {
        const url = imageUrl({ messageId: "msg_1", index: 0, userId: "usr_7" });
        // Somebody else's message id in the path, this pass in the address.
        expect(readImagePass(tokenOf(url), "msg_2", 0)).toBeNull();
    });

    it("cannot be moved onto another picture in the same message", () => {
        // Otherwise one pass would walk a message's pictures one number at a
        // time, which is the whole message.
        const url = imageUrl({ messageId: "msg_1", index: 0, userId: "usr_7" });
        expect(readImagePass(tokenOf(url), "msg_1", 1)).toBeNull();
    });

    it("refuses a payload somebody rewrote", () => {
        const url = imageUrl({ messageId: "msg_1", index: 0, userId: "usr_7" });
        const [, signature] = tokenOf(url).split(".");
        const forged = Buffer.from("msg_1:0:usr_9:99999999999999", "utf8").toString("base64url");
        expect(readImagePass(`${forged}.${signature}`, "msg_1", 0)).toBeNull();
    });

    it("refuses nonsense rather than throwing", () => {
        // The signature comparison is constant-time, which throws on a length
        // mismatch unless the lengths are checked first.
        for (const token of ["", ".", "x", "x.y", "....", "a".repeat(500)]) {
            expect(() => readImagePass(token, "msg_1", 0)).not.toThrow();
            expect(readImagePass(token, "msg_1", 0)).toBeNull();
        }
    });

    it("stops working", () => {
        const payload = Buffer.from(`msg_1:0:usr_7:${Date.now() - 1000}`, "utf8").toString("base64url");
        // Signed properly - it is the clock that refuses it, not the signature.
        const url = imageUrl({ messageId: "msg_1", index: 0, userId: "usr_7" });
        const good = readImagePass(tokenOf(url), "msg_1", 0);
        expect(good).not.toBeNull();
        expect(readImagePass(`${payload}.anything`, "msg_1", 0)).toBeNull();
    });
});

describe("a picture that is not passed on", () => {
    it("answers with no body, which is what a 204 is", async () => {
        const route = await readFile(
            fileURLToPath(
                new URL(
                    "../../src/app/api/mail/image/[messageId]/[index]/[token]/route.ts",
                    import.meta.url
                )
            ),
            "utf8"
        );
        expect(route).toContain("new Response(null, { status: 204 })");
        expect(route).not.toContain('new Response("", { status: 204 })');
    });
});
