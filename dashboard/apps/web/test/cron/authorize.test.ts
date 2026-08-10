/**
 * Who may trigger scheduled work from outside.
 *
 * Six routes used to carry a copy of this each, comparing the presented token
 * with `!==`. The contract they were written against has to keep working - an
 * installer that already sends a bearer token must not start being refused - and
 * the comparison has to stop leaking the secret to whoever is timing the replies.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let secret: string | undefined = "the-real-secret";

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_CRON_SECRET: secret }) }));

const { authorizeCron, presentedToken } = await import("../../src/lib/cron/authorize");

const asking = (headers: Record<string, string>) =>
    new Request("https://polaris.local/api/cron/backups", { method: "POST", headers });

describe("reading the token off a request", () => {
    it("takes a bearer token", () => {
        expect(presentedToken(asking({ authorization: "Bearer abc" }))).toBe("abc");
    });

    it("takes the header form as well, which is what most schedulers send", () => {
        expect(presentedToken(asking({ "x-cron-key": "abc" }))).toBe("abc");
    });

    it("is nothing when neither was sent", () => {
        expect(presentedToken(asking({}))).toBe("");
    });
});

describe("deciding whether a caller may run scheduled work", () => {
    beforeEach(() => {
        secret = "the-real-secret";
    });

    it("lets the right token through in either shape", () => {
        expect(authorizeCron(asking({ authorization: "Bearer the-real-secret" }))).toBeNull();
        expect(authorizeCron(asking({ "x-cron-key": "the-real-secret" }))).toBeNull();
    });

    it("refuses a wrong token of the same length", () => {
        const refused = authorizeCron(asking({ authorization: "Bearer the-fake-secret!" }));
        expect(refused?.status).toBe(401);
    });

    it("refuses a wrong token of a different length, rather than throwing", () => {
        // timingSafeEqual rejects buffers of unequal length outright, so the
        // comparison is over digests - otherwise this case is a 500 that tells the
        // caller their guess was at least the wrong size.
        expect(authorizeCron(asking({ authorization: "Bearer x" }))?.status).toBe(401);
        expect(authorizeCron(asking({ "x-cron-key": "x".repeat(500) }))?.status).toBe(401);
    });

    it("refuses a request with no token at all", () => {
        expect(authorizeCron(asking({}))?.status).toBe(401);
    });

    it("shuts the door when no secret is set, rather than opening it", () => {
        secret = undefined;
        expect(authorizeCron(asking({}))?.status).toBe(503);
        expect(authorizeCron(asking({ authorization: "Bearer anything" }))?.status).toBe(503);
    });

    it("treats an empty secret as no secret", () => {
        secret = "";
        expect(authorizeCron(asking({ authorization: "Bearer " }))?.status).toBe(503);
    });
});
