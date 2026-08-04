/**
 * The address a round trip through an outside provider is registered on.
 *
 * This is the regression it exists for: the GitHub App flow built every URL from the
 * tab it was started in, so an instance opened on `http://0.0.0.0:3000` registered an
 * app whose callback GitHub duly sent people to - an address that is the socket the
 * server binds, not one a browser will navigate to.
 *
 * The correction is deliberately narrow. Preferring the configured domain outright is
 * what broke it the other way: a domain saved in settings but not yet routed by the
 * edge answers 404, and the flow was moved onto it. So only the bind address is
 * rewritten here, and the domain is used by the caller once it has answered a probe.
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
        }
    }
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_APP_URL: "http://polaris.local" }) }));

vi.mock("@polaris/storage", () => ({ decryptSecret: () => "", encryptSecret: () => "" }));

vi.mock("../../src/lib/domain-zones", () => ({
    zoneReachable: async () => state.zoneReachable,
    polarisZoneHost: async () => state.zoneHost
}));

vi.mock("../../src/lib/polaris-tunnel-service", () => ({ getPolarisPublicUrl: async () => state.tunnel }));

const { browserOrigin, publicAppUrl } = await import("../../src/lib/domain-service");

describe("browserOrigin", () => {
    it("never hands back the bind address, which no browser can return to", () => {
        expect(browserOrigin("http://0.0.0.0:3000")).toBe("http://localhost:3000");
        expect(browserOrigin("http://[::]:3000")).toBe("http://localhost:3000");
    });

    it("leaves an address the browser is demonstrably using alone", () => {
        expect(browserOrigin("http://192.168.1.40:3000")).toBe("http://192.168.1.40:3000");
        expect(browserOrigin("https://polaris.example.com")).toBe("https://polaris.example.com");
    });
});

describe("publicAppUrl", () => {
    beforeEach(() => {
        store.clear();
        state.zoneReachable = false;
        state.zoneHost = null;
        state.tunnel = null;
    });

    it("is the app domain when the internet can reach it", async () => {
        store.set("domain.app", "polaris.example.com");
        expect(await publicAppUrl()).toBe("https://polaris.example.com");
    });

    it("is nothing on a LAN-only install, so no webhook is registered", async () => {
        expect(await publicAppUrl()).toBeNull();
    });
});
