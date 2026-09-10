/**
 * The plumbing every Deploy API route runs through: no key, no call; a key in a
 * loop is slowed down; a body of the wrong shape is refused with the field that
 * was wrong; and nothing thrown underneath reaches the caller as it was.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateApiKey = vi.fn();
const rateLimit = vi.fn();

vi.mock("@/lib/api-key-auth", () => ({
    authenticateApiKey: (...args: unknown[]) => authenticateApiKey(...args)
}));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: (...args: unknown[]) => rateLimit(...args)
}));

const { deployRoute, readBody, respond } = await import("@/lib/deploy/api/http");
const { DeployApiRefusal } = await import("@/lib/deploy/api/refusal");
const { addDomainSchema, setVariableSchema, serviceRefSchema } = await import(
    "@/lib/deploy/api/schemas"
);

const segment = { params: Promise.resolve({ id: "svc" }) };

function request(body?: string): Request {
    return new Request("https://polaris.test/api/v1/deploy/services/svc/deploy", {
        method: "POST",
        headers: { authorization: "Bearer plk_test.secret" },
        body
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    authenticateApiKey.mockResolvedValue({
        keyId: "key-1",
        userId: "user-1",
        scopes: ["deploy.read"],
        projectId: "project-1"
    });
    rateLimit.mockResolvedValue({ ok: true, retryAfterMs: 0 });
});

describe("deployRoute", () => {
    it("refuses a call with no usable key before running anything", async () => {
        authenticateApiKey.mockResolvedValue(null);
        const handler = vi.fn();
        const response = await deployRoute("deploy", true, handler)(request(), segment);
        expect(response.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
    });

    it("hands the handler a caller carrying the key, its scopes and its project", async () => {
        const handler = vi.fn(async () => new Response("ok"));
        await deployRoute("deploy", false, handler)(request(), segment);
        expect(handler).toHaveBeenCalledWith(
            expect.objectContaining({
                caller: {
                    userId: "user-1",
                    scopes: ["deploy.read"],
                    keyId: "key-1",
                    projectId: "project-1",
                    via: "api"
                },
                params: { id: "svc" }
            })
        );
    });

    it("counts changes against a stricter limit, and says when to try again", async () => {
        rateLimit.mockImplementation(async (bucket: string) =>
            bucket.startsWith("deploy-api-change:")
                ? { ok: false, retryAfterMs: 12_300 }
                : { ok: true, retryAfterMs: 0 }
        );
        const response = await deployRoute("deploy", true, vi.fn())(request(), segment);
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("13");
        // A read is not held back by the change limit.
        const read = await deployRoute(
            "read",
            false,
            async () => new Response("ok")
        )(request(), segment);
        expect(read.status).toBe(200);
    });

    it("names the field that was wrong", async () => {
        const response = await deployRoute("save", true, async ({ request: incoming }) => {
            setVariableSchema.parse(await readBody(incoming));
            return new Response("ok");
        })(request(JSON.stringify({ key: "1BAD", value: "x" })), segment);
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toMatch(/^key: /);
    });

    it("refuses a body that is not JSON", async () => {
        const response = await deployRoute("save", true, async ({ request: incoming }) => {
            await readBody(incoming);
            return new Response("ok");
        })(request("{not json"), segment);
        expect(response.status).toBe(400);
    });

    it("passes a refusal through and keeps anything else in the log", async () => {
        const refused = await deployRoute("deploy", true, async () => {
            throw new DeployApiRefusal(409, "Two services match.");
        })(request(), segment);
        expect(refused.status).toBe(409);
        expect(await refused.json()).toEqual({ error: "Two services match." });

        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const broken = await deployRoute("deploy the service", true, async () => {
            throw new Error("hostd docker proxy failed (502): /var/run/docker.sock");
        })(request(), segment);
        quiet.mockRestore();
        expect(broken.status).toBe(500);
        expect(JSON.stringify(await broken.json())).not.toContain("docker.sock");
    });
});

describe("respond", () => {
    it("answers text when it was asked for and the route offers it", async () => {
        const url = new URL("https://polaris.test/x?format=text");
        const response = respond(url, { id: "1" }, () => "1\n");
        expect(response.headers.get("content-type")).toContain("text/plain");
        expect(await response.text()).toBe("1\n");
    });

    it("answers JSON otherwise", async () => {
        const response = respond(new URL("https://polaris.test/x"), { id: "1" }, () => "1\n");
        expect(await response.json()).toEqual({ id: "1" });
    });
});

describe("the input shapes", () => {
    it("accepts the three ways of naming a service, and nothing else", () => {
        for (const ok of ["0197f3c4-0000-7000-8000-000000000000", "shop/api", "shop/staging/api"]) {
            expect(serviceRefSchema.safeParse(ok).success, ok).toBe(true);
        }
        for (const bad of ["", "a/b/c/d", "shop//api", "/api"]) {
            expect(serviceRefSchema.safeParse(bad).success, bad).toBe(false);
        }
    });

    it("keeps variables secret unless told otherwise", () => {
        expect(setVariableSchema.parse({ key: "TOKEN", value: "x" }).secret).toBe(true);
    });

    it("refuses a hostname that is not one, and a port out of range", () => {
        expect(addDomainSchema.safeParse({ hostname: "not a host" }).success).toBe(false);
        expect(addDomainSchema.safeParse({ targetPort: 70000 }).success).toBe(false);
        expect(addDomainSchema.parse({ hostname: "API.Example.test" }).hostname).toBe(
            "api.example.test"
        );
    });
});
