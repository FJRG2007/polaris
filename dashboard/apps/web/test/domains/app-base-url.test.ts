/**
 * The address Polaris puts in a link it hands out. `POLARIS_APP_URL` is the LAN
 * name the installer writes (`http://polaris.local`), which resolves over mDNS and
 * nowhere else, so it has to lose to every address that is reachable from outside.
 * An invite built on it cannot be opened by the person invited, which is the whole
 * point of an invite.
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
            upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
                store.set(where.key, create.value);
            },
            deleteMany: async ({ where }: { where: { key: string } }) => {
                store.delete(where.key);
            }
        }
    }
}));

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_APP_URL: "http://polaris.local" })
}));

vi.mock("@polaris/storage", () => ({
    decryptSecret: () => "",
    encryptSecret: () => ""
}));

vi.mock("../../src/lib/domain-edge", () => ({ syncDashboardRoute: async () => undefined }));

vi.mock("../../src/lib/domain-zones", () => ({
    zoneReachable: async () => state.zoneReachable,
    polarisZoneHost: async () => state.zoneHost
}));

vi.mock("../../src/lib/polaris-tunnel-service", () => ({
    getPolarisPublicUrl: async () => state.tunnel
}));

const { appBaseUrl, sharingBaseUrl } = await import("../../src/lib/domain-service");

describe("appBaseUrl", () => {
    beforeEach(() => {
        store.clear();
        state.zoneReachable = false;
        state.zoneHost = null;
        state.tunnel = null;
    });

    it("uses the configured app domain above everything else", async () => {
        store.set("domain.app", "polaris.example.com");
        state.tunnel = "https://tunnel.example.com";
        expect(await appBaseUrl()).toBe("https://polaris.example.com");
    });

    it("prefers a proven zone over the LAN name", async () => {
        state.zoneReachable = true;
        state.zoneHost = "polaris.example.com";
        expect(await appBaseUrl()).toBe("https://polaris.example.com");
    });

    it("prefers a running tunnel over the LAN name", async () => {
        state.tunnel = "https://calm-river.trycloudflare.com";
        expect(await appBaseUrl()).toBe("https://calm-river.trycloudflare.com");
    });

    it("prefers a DuckDNS subdomain over the LAN name", async () => {
        store.set("domain.duckdns.subdomain", "myhome");
        expect(await appBaseUrl()).toBe("https://myhome.duckdns.org");
    });

    it("prefers a free public-IP subdomain over the LAN name", async () => {
        store.set("domain.publicIp", "51.15.20.30");
        expect(await appBaseUrl()).toMatch(/^https:\/\/app-[a-z0-9]+-51-15-20-30\.sslip\.io$/);
    });

    it("falls back to the LAN name only when nothing else is reachable", async () => {
        expect(await appBaseUrl()).toBe("http://polaris.local");
    });
});

describe("sharingBaseUrl", () => {
    beforeEach(() => {
        store.clear();
        state.zoneReachable = false;
        state.zoneHost = null;
        state.tunnel = null;
    });

    it("keeps its own domain ahead of the app domain", async () => {
        store.set("domain.app", "polaris.example.com");
        store.set("domain.sharing", "files.example.net");
        expect(await sharingBaseUrl()).toBe("https://files.example.net");
    });

    it("prefers a reachable address over the app domain, unlike the app URL", async () => {
        store.set("domain.app", "polaris.example.com");
        state.tunnel = "https://calm-river.trycloudflare.com";
        expect(await sharingBaseUrl()).toBe("https://calm-river.trycloudflare.com");
    });

    it("labels its free subdomain differently from the app one", async () => {
        store.set("domain.publicIp", "51.15.20.30");
        expect(await sharingBaseUrl()).toMatch(/^https:\/\/share-[a-z0-9]+-51-15-20-30\.sslip\.io$/);
    });
});
