/**
 * A TV's key opens Polaris TV's routes and nothing else: every other caller of
 * `authenticateApiKey` is told there is no key, MCP and `/api/v1/me` among them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let kind = "tv";

vi.mock("@polaris/auth", () => ({
    verifyApiKey: async () => ({
        id: "key-1",
        userId: "user-1",
        scopes: [],
        projectId: null,
        kind,
        rules: {},
        clients: {}
    }),
    touchApiKey: async () => undefined
}));
vi.mock("@polaris/core", () => ({ userAgentAllowed: () => true }));
vi.mock("@/lib/cli/sessions", () => ({ cliAddressAllows: async () => true }));
vi.mock("@/lib/network-rules", () => ({
    evaluateAccountAccess: async () => ({ allowed: true })
}));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "203.0.113.4",
    clientUserAgent: async () => "polaris-tv/3.3"
}));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/api-usage/recorder", () => ({ noteKeyCall: () => undefined }));

const { authenticateApiKey, requireApiKey } = await import("@/lib/api-key-auth");

function asked(): Request {
    return new Request("https://polaris.example/api/mcp", {
        headers: { authorization: "Bearer key" }
    });
}

beforeEach(() => {
    kind = "tv";
});

describe("how far a TV's key reaches", () => {
    it("is no key to anything but a TV route", async () => {
        expect(await authenticateApiKey(asked())).toBeNull();
        const refused = await requireApiKey(asked());
        expect((refused as Response).status).toBe(401);
    });

    it("is a key to a TV route", async () => {
        expect(await authenticateApiKey(asked(), { tv: true })).toMatchObject({ kind: "tv" });
    });

    it("leaves every other kind as it was", async () => {
        kind = "cli";
        expect(await authenticateApiKey(asked())).toMatchObject({ kind: "cli" });
    });
});
