/**
 * The Polaris public tunnel between shares.
 *
 * What is pinned: a tunnel that is no longer needed - a sharing domain, a zone
 * that answers, a box reachable on its own - is taken down; one that is needed
 * but forwards to an old origin is raised again; and nothing is started where
 * there was no tunnel to begin with.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    presence: "none" as "none" | "serving" | "stale",
    sharingDomain: null as string | null,
    zone: false,
    autoPublic: false,
    stopped: 0,
    ensured: 0
}));

vi.mock("@/lib/domain-service", () => ({
    getDomainConfig: async () => ({ sharingDomain: fake.sharingDomain })
}));
vi.mock("@/lib/domain-zones", () => ({ zoneReachable: async () => fake.zone }));
vi.mock("@/lib/network-service", () => ({
    getNetworkStatus: async () => ({ autoSubdomainsPublic: fake.autoPublic })
}));
vi.mock("@/lib/polaris-tunnel-service", () => ({
    polarisTunnelPresence: async () => fake.presence,
    stopPolarisTunnel: async () => {
        fake.stopped += 1;
    },
    ensurePolarisTunnel: async () => {
        fake.ensured += 1;
        return "https://example.trycloudflare.com";
    }
}));

const { settleShareTunnel } = await import("@/lib/public-reach");

beforeEach(() => {
    Object.assign(fake, {
        presence: "none",
        sharingDomain: null,
        zone: false,
        autoPublic: false,
        stopped: 0,
        ensured: 0
    });
});

describe("settling the public tunnel", () => {
    it("takes a stale tunnel down once a domain answers", async () => {
        Object.assign(fake, { presence: "stale", zone: true });
        expect(await settleShareTunnel()).toBe("removed");
        expect(fake.stopped).toBe(1);
        expect(fake.ensured).toBe(0);
    });

    it("takes a working tunnel down when a sharing domain is set", async () => {
        Object.assign(fake, { presence: "serving", sharingDomain: "share.example.com" });
        expect(await settleShareTunnel()).toBe("removed");
    });

    it("raises a needed tunnel again when it forwards to an old origin", async () => {
        fake.presence = "stale";
        expect(await settleShareTunnel()).toBe("repaired");
        expect(fake.ensured).toBe(1);
        expect(fake.stopped).toBe(0);
    });

    it("leaves a needed, working tunnel alone and starts none where there was none", async () => {
        fake.presence = "serving";
        expect(await settleShareTunnel()).toBe("unchanged");
        fake.presence = "none";
        expect(await settleShareTunnel()).toBe("unchanged");
        expect(fake.ensured + fake.stopped).toBe(0);
    });
});
