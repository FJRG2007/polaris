/**
 * The faces the extension draws: the connected account's own, and the marks of
 * the organizations it belongs to - and nobody else's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "11111111-1111-4111-8111-111111111111";
const ACME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

let principal: { userId: string } | null;
const photo = (bytes: number[]) => ({
    etag: "e",
    mime: "image/png",
    load: async () => new Uint8Array(bytes)
});

vi.mock("@/lib/extension/sessions", () => ({
    bearerToken: (request: Request) => request.headers.get("authorization")?.split(" ")[1] ?? null,
    readExtensionToken: async (token: string | null) => (token === "good" ? principal : null)
}));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => null,
    clientUserAgent: async () => null,
    clientHost: async () => null
}));
vi.mock("@/lib/workspace-scope", () => ({
    scopeChoices: async () => [{ id: ACME, slug: "acme", name: "Acme" }]
}));
const resolveAvatar = vi.fn(async () => ({ picture: photo([1, 2]), certain: true }));
const resolveOrgAvatar = vi.fn(async () => photo([3]));
vi.mock("@/lib/avatar-service", () => ({ resolveAvatar, resolveOrgAvatar }));

const { GET } = await import("@/app/api/extension/avatar/route");

const ask = (query = "", token = "good") =>
    GET(
        new Request(`https://polaris.example/api/extension/avatar${query}`, {
            headers: { authorization: `Bearer ${token}` }
        })
    );

beforeEach(() => {
    principal = { userId: ALICE };
    resolveAvatar.mockClear();
    resolveOrgAvatar.mockClear();
});

describe("the extension's faces", () => {
    it("refuses a token that is not a live connection", async () => {
        expect((await ask("", "bad")).status).toBe(401);
    });

    it("serves the connected account's own face", async () => {
        const reply = await ask();
        expect(reply.status).toBe(200);
        expect(reply.headers.get("content-type")).toBe("image/png");
        expect(resolveAvatar).toHaveBeenCalledWith(ALICE);
    });

    it("serves the mark of an organization the account is in", async () => {
        const reply = await ask(`?org=${ACME}`);
        expect(reply.status).toBe(200);
        expect(resolveOrgAvatar).toHaveBeenCalledWith(ACME);
    });

    it("answers another organization exactly as one with no picture", async () => {
        const reply = await ask(`?org=${OTHER}`);
        expect(reply.status).toBe(204);
        expect(resolveOrgAvatar).not.toHaveBeenCalled();
    });

    it("says there is none rather than sending a blank picture", async () => {
        resolveAvatar.mockResolvedValueOnce({ picture: null, certain: true } as never);
        expect((await ask()).status).toBe(204);
    });

    it("refuses an organization id that is not one", async () => {
        expect((await ask("?org=nope")).status).toBe(400);
    });
});
