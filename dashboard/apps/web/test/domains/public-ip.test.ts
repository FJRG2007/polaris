/**
 * Which address Polaris reports as this server's.
 *
 * It used to be whatever was detected the first time anyone deployed, stored and
 * never looked at again. On a box with a wired link and a wireless one that is a
 * coin flip, and the day the wireless lease moves the stored value names an address
 * nothing answers on - which is how every "open this app at its IP" link, and every
 * route written against it, quietly stopped working while the machine was perfectly
 * healthy. Detection therefore outranks the stored value; a person's own entry does
 * not, because the address they typed may be one detection cannot see.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, state } = vi.hoisted(() => ({
    store: new Map<string, string>(),
    state: { detected: null as string | null }
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

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_APP_URL: "http://polaris.local" }) }));
vi.mock("@polaris/storage", () => ({ decryptSecret: () => "", encryptSecret: () => "" }));
vi.mock("../../src/lib/domain-edge", () => ({
    syncDashboardRoute: async () => undefined,
    publicHostname: (value: string) => value
}));
vi.mock("../../src/lib/domain-zones", () => ({
    zoneReachable: async () => false,
    polarisZoneHost: async () => null
}));
vi.mock("../../src/lib/polaris-tunnel-service", () => ({ getPolarisPublicUrl: async () => null }));
vi.mock("../../src/lib/host-address", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/lib/host-address")>()),
    getHostLanIp: async () => state.detected
}));

const { getPublicIp, setDomainConfig, ensurePublicIp } = await import("../../src/lib/domain-service");

describe("getPublicIp", () => {
    beforeEach(() => {
        store.clear();
        state.detected = null;
        delete process.env.POLARIS_PUBLIC_IP;
    });

    it("corrects a detected address that has gone stale", async () => {
        await ensurePublicIp("192.168.1.138");
        state.detected = "192.168.1.142";
        expect(await getPublicIp()).toBe("192.168.1.142");
    });

    it("keeps the stored address when nothing is detected", async () => {
        await ensurePublicIp("192.168.1.138");
        expect(await getPublicIp()).toBe("192.168.1.138");
    });

    it("keeps an address that was entered by hand", async () => {
        await setDomainConfig({ publicIp: "203.0.113.9" });
        state.detected = "192.168.1.142";
        expect(await getPublicIp()).toBe("203.0.113.9");
    });

    it("hands the address back to detection when the entered one is cleared", async () => {
        await setDomainConfig({ publicIp: "203.0.113.9" });
        await setDomainConfig({ publicIp: "" });
        state.detected = "192.168.1.142";
        expect(await getPublicIp()).toBe("192.168.1.142");
    });

    it("uses detection before the install-time variable", async () => {
        process.env.POLARIS_PUBLIC_IP = "192.168.1.138";
        state.detected = "192.168.1.142";
        expect(await getPublicIp()).toBe("192.168.1.142");
    });

    it("falls back to the install-time variable when nothing else is known", async () => {
        process.env.POLARIS_PUBLIC_IP = "192.168.1.138";
        expect(await getPublicIp()).toBe("192.168.1.138");
    });
});
