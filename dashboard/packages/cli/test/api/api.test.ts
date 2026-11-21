/**
 * Every answer is validated before it is read, and every failure is a sentence
 * that says what to do - never `undefined`, never a stack.
 */

import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { Fetch } from "../../src/api.js";
import { CliError } from "../../src/errors.js";
import { call, unreachableReason } from "../../src/api.js";
import { projectsSchema, serviceSchema } from "../../src/schemas.js";

const connection = { url: "https://polaris.example.com", token: "plk_TESTONLY.fixture" };

function answering(response: Response): {
    fetch: Fetch;
    requests: { url: string; init?: RequestInit }[];
} {
    const requests: { url: string; init?: RequestInit }[] = [];
    return {
        requests,
        fetch: async (input, init) => {
            requests.push({ url: String(input), init });
            return response;
        }
    };
}

async function failure(promise: Promise<unknown>): Promise<CliError> {
    try {
        await promise;
    } catch (caught) {
        expect(caught).toBeInstanceOf(CliError);
        return caught as CliError;
    }
    throw new Error("expected a failure");
}

describe("a good answer", () => {
    it("is parsed and the token travels only in the Authorization header", async () => {
        const { fetch, requests } = answering(Response.json({ projects: [] }));
        expect(
            await call(connection, "GET", "/api/v1/deploy/projects", projectsSchema, { fetch })
        ).toEqual({ projects: [] });
        const sent = requests[0]!;
        expect(sent.url).toBe("https://polaris.example.com/api/v1/deploy/projects");
        expect(sent.url).not.toContain("plk_");
        expect(new Headers(sent.init?.headers).get("authorization")).toBe(
            "Bearer plk_TESTONLY.fixture"
        );
        expect(new Headers(sent.init?.headers).get("user-agent")).toMatch(/^polaris-cli\//);
        expect(sent.init?.redirect).toBe("manual");
    });
});

describe("an answer in the wrong shape", () => {
    it("is refused in words rather than half-read", async () => {
        const { fetch } = answering(Response.json({ service: { id: "x" } }));
        const error = await failure(
            call(connection, "GET", "/api/v1/deploy/services?ref=a/b", serviceSchema, { fetch })
        );
        expect(error.message).toContain("does not understand");
        expect(error.message).toContain("plr update");
    });

    it("treats an HTML page (a proxy, a captive portal) the same way", async () => {
        const { fetch } = answering(new Response("<html>login</html>", { status: 200 }));
        const error = await failure(
            call(connection, "GET", "/api/v1/me", z.object({ user: z.object({}) }), { fetch })
        );
        expect(error.message).toContain("does not understand");
    });
});

describe("a refusal", () => {
    it("401 says it was signed out from Polaris, and to sign in again", async () => {
        const { fetch } = answering(Response.json({ error: "Unauthorized" }, { status: 401 }));
        const error = await failure(call(connection, "GET", "/api/v1/me", z.object({}), { fetch }));
        expect(error.message).toBe(
            "You were signed out from Polaris at https://polaris.example.com (the sign-in was ended there, or it expired). Run plr login to sign in again."
        );
    });

    it("403 names the permission that was missing", async () => {
        const { fetch } = answering(
            Response.json({ error: "Forbidden", requiredScope: "deploy.manage" }, { status: 403 })
        );
        const error = await failure(call(connection, "POST", "/x", z.object({}), { fetch }));
        expect(error.message).toContain("deploy.manage");
    });

    it("anything else passes the server's own sentence on", async () => {
        const { fetch } = answering(Response.json({ error: "Not found" }, { status: 404 }));
        expect(
            (await failure(call(connection, "GET", "/x", z.object({}), { fetch }))).message
        ).toBe("Not found");
    });

    it("a redirect is not followed with the token; its address is named instead", async () => {
        const { fetch } = answering(
            new Response(null, {
                status: 308,
                headers: { location: "https://other.example.com/api/v1/me" }
            })
        );
        const error = await failure(call(connection, "GET", "/api/v1/me", z.object({}), { fetch }));
        expect(error.message).toContain("plr login --url https://other.example.com");
    });
});

describe("no answer at all", () => {
    it("says why, in words", async () => {
        const refused = Object.assign(new TypeError("fetch failed"), {
            cause: { code: "ECONNREFUSED" }
        });
        const fetch: Fetch = async () => {
            throw refused;
        };
        const error = await failure(call(connection, "GET", "/api/v1/me", z.object({}), { fetch }));
        expect(error.message).toBe(
            "Could not reach https://polaris.example.com: nothing is answering at that address."
        );
    });

    it("tells a name that does not resolve and an untrusted certificate apart", () => {
        expect(unreachableReason({ cause: { code: "ENOTFOUND" } })).toContain("does not resolve");
        expect(unreachableReason({ cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } })).toContain(
            "NODE_EXTRA_CA_CERTS"
        );
        expect(unreachableReason({ name: "TimeoutError" })).toContain("in time");
    });
});
