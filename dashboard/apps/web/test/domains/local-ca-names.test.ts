/**
 * The names on the local certificate.
 *
 * The leaf is re-issued whenever this list changes, and every re-issue invalidates
 * the trust a browser had already granted - which shows up first as a terminal that
 * will not connect, because a WebSocket refuses an untrusted certificate outright.
 * So the list must not move on its own: no docker-internal address (a new one on
 * every container recreate) and no dependence on the order rows came back in.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn(async () => [{ hostname: "app.plr.local" }, { hostname: "a.192-168-1-8.sslip.io" }]);
const access = vi.fn(async () => undefined);
const hostLanIp = vi.fn(async () => "192.168.1.42" as string | null);
const interfaces = vi.fn(() => ({
    lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    eth0: [{ family: "IPv4", internal: false, address: "172.18.0.8" }]
}));

vi.mock("@polaris/db", () => ({ prisma: { domain: { findMany } } }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_DATA_DIR: "/var/lib/polaris" }) }));
vi.mock("@/lib/host-address", () => ({ getHostLanIp: hostLanIp }));
vi.mock("node:os", () => ({ networkInterfaces: interfaces }));
vi.mock("node:fs/promises", () => ({
    access,
    mkdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn()
}));

const { subjectAltNames } = await import("../../src/lib/local-ca-service");

describe("the local certificate's names", () => {
    beforeEach(() => {
        process.env.POLARIS_PUBLIC_IP = "192.168.1.138";
        delete process.env.POLARIS_PUBLIC_DOMAIN;
        access.mockResolvedValue(undefined);
    });

    it("covers the LAN names and the addresses a browser reaches", async () => {
        const names = await subjectAltNames();
        expect(names).toContain("DNS:polaris.local");
        expect(names).toContain("DNS:*.plr.local");
        expect(names).toContain("DNS:app.plr.local");
        expect(names).toContain("IP:192.168.1.138");
        expect(names).toContain("IP:192.168.1.42");
        expect(names).toContain("IP:127.0.0.1");
    });

    it("leaves out the container's own docker address", async () => {
        expect(await subjectAltNames()).not.toContain("IP:172.18.0.8");
    });

    it("uses the machine's own interfaces when Polaris runs on it directly", async () => {
        // No /.dockerenv: the interfaces are the ones clients actually connect to.
        access.mockRejectedValue(new Error("ENOENT"));
        interfaces.mockReturnValueOnce({
            lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
            enp3s0: [{ family: "IPv4", internal: false, address: "192.168.1.7" }]
        });
        expect(await subjectAltNames()).toContain("IP:192.168.1.7");
    });

    it("does not change when the same domains come back in another order", async () => {
        const first = await subjectAltNames();
        findMany.mockResolvedValueOnce([{ hostname: "a.192-168-1-8.sslip.io" }, { hostname: "app.plr.local" }]);
        expect(await subjectAltNames()).toEqual(first);
    });

    it("survives a database that is not up yet", async () => {
        findMany.mockRejectedValueOnce(new Error("connection refused"));
        expect(await subjectAltNames()).toContain("DNS:polaris.local");
    });
});
