/**
 * The redirect URI an operator is told to register, and the one Polaris sends.
 *
 * They were two different strings. The Integrations screen built its from the
 * deployment's own address, which is the one worth pasting into a provider's
 * console, while the flow built its from the request - and behind the proxy that
 * is the socket the server binds. So the screen said
 * `https://polaris.example.com/api/connections/google/callback`, the operator
 * registered exactly that, and Google was handed `https://0.0.0.0:3000/...` and
 * refused it.
 *
 * One function now answers both, which is the only way they cannot drift again.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, state } = vi.hoisted(() => ({
    store: new Map<string, string>(),
    state: { zoneReachable: false, zoneHost: null as string | null, tunnel: null as string | null }
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        setting: {
            findUnique: async ({ where }: { where: { key: string } }) => {
                const value = store.get(where.key);
                return value === undefined ? null : { value };
            },
            upsert: async () => undefined,
            deleteMany: async () => undefined
        },
        integration: { findUnique: async () => null, findMany: async () => [] }
    }
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_APP_URL: "http://polaris.local" }) }));
vi.mock("@polaris/storage", () => ({ decryptSecret: () => "", encryptSecret: () => "" }));
vi.mock("@/lib/domain-zones", () => ({ zoneReachable: async () => state.zoneReachable, polarisZoneHost: async () => state.zoneHost }));
vi.mock("@/lib/polaris-tunnel-service", () => ({ getPolarisPublicUrl: async () => state.tunnel }));

const { connectionFlowOrigin, connectionRedirectUri } = await import("@/lib/connections/oauth");

describe("connectionRedirectUri", () => {
    beforeEach(() => {
        store.clear();
        state.zoneReachable = false;
        state.zoneHost = null;
        state.tunnel = null;
    });

    it("is on the domain the operator configured, which is the one they registered", async () => {
        store.set("domain.app", "polaris.example.com");

        expect(await connectionFlowOrigin()).toBe("https://polaris.example.com");
        expect(await connectionRedirectUri("google")).toBe("https://polaris.example.com/api/connections/google/callback");
    });

    it("gives each service the path it registers, GitHub's included", async () => {
        store.set("domain.app", "polaris.example.com");

        // GitHub's is under /api/integrations because that is what its App carries;
        // moving it would break linking on every deployment already connected.
        expect(await connectionRedirectUri("github")).toBe(
            "https://polaris.example.com/api/integrations/github/link/callback"
        );
        expect(await connectionRedirectUri("microsoft")).toBe(
            "https://polaris.example.com/api/connections/microsoft/callback"
        );
        expect(await connectionRedirectUri("steam")).toBe("https://polaris.example.com/api/connections/steam/callback");
    });

    it("falls back to the address this install was given, never to the bind address", async () => {
        expect(await connectionFlowOrigin()).toBe("http://polaris.local");
    });
});
