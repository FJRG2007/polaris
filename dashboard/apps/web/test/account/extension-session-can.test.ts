/**
 * What the extension's connection says the account may do: the vault, and
 * Polar decided the way the dashboard decides it, so the extension shows its
 * Polar entries only to an account that can use them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    polar: true as boolean | "throws",
    vault: true
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findUnique: vi.fn(async () => ({ id: "u1", name: "Ada", email: "ada@example.com" }))
        },
        vaultOrganization: { findMany: vi.fn(async () => []) }
    }
}));
vi.mock("@polaris/auth", () => ({ userHasPermission: vi.fn(async () => state.vault) }));
vi.mock("@/lib/request-context", () => ({
    clientHost: vi.fn(async () => null),
    clientIp: vi.fn(async () => null),
    clientUserAgent: vi.fn(async () => null)
}));
vi.mock("@/lib/workspace-scope", () => ({ scopeChoices: vi.fn(async () => []) }));
vi.mock("@/lib/i18n/locale-service", () => ({ storedLocale: vi.fn(async () => null) }));
vi.mock("@/lib/extension/sessions", () => ({
    bearerToken: () => "token",
    readExtensionToken: vi.fn(async () => ({ id: "c1", name: "Chrome", userId: "u1" })),
    revokeExtensionToken: vi.fn()
}));
vi.mock("@/lib/polar/access", () => ({
    polarAccessFor: vi.fn(async () => {
        if (state.polar === "throws") throw new Error("policy unreadable");
        return { use: state.polar };
    })
}));

const { GET } = await import("@/app/api/extension/session/route");

async function can(): Promise<Record<string, unknown>> {
    const response = await GET(new Request("https://polaris.example/api/extension/session"));
    const body = (await response.json()) as { can: Record<string, unknown> };
    return body.can;
}

beforeEach(() => {
    state.polar = true;
    state.vault = true;
});

describe("the extension's connection", () => {
    it("says the account may use Polar when the dashboard would let it", async () => {
        expect(await can()).toEqual({ vault: true, polar: true });
    });

    it("says no for an account Polar is kept from", async () => {
        state.polar = false;
        expect(await can()).toEqual({ vault: true, polar: false });
    });

    it("says no when the decision cannot be made", async () => {
        state.polar = "throws";
        expect((await can()).polar).toBe(false);
    });
});
