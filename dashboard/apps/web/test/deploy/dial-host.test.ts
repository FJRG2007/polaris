/**
 * Which address an app's edge route is written against.
 *
 * The whole point of this module is that it is NOT the box's LAN address: that one
 * is a DHCP lease on whichever interface answered first, and a route written against
 * it 502s every deployed domain on the instance the moment the lease moves or the
 * interface drops - with healthy containers behind it the entire time. The name the
 * compose file grants the edge does not move, so it wins; the LAN address is only
 * what an instance whose compose predates the variable falls back to.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({ state: { publicIp: null as string | null } }));

vi.mock("../../src/lib/domain-service", () => ({
    getPublicIp: async () => state.publicIp
}));

async function load(): Promise<typeof import("../../src/lib/deploy/dial")> {
    vi.resetModules();
    return import("../../src/lib/deploy/dial");
}

afterEach(() => {
    delete process.env.POLARIS_APP_DIAL_HOST;
    delete process.env.POLARIS_EDGE_ORIGIN;
    state.publicIp = null;
});

describe("localDialHost", () => {
    it("uses the host name the edge was configured with", async () => {
        process.env.POLARIS_APP_DIAL_HOST = "host.docker.internal";
        state.publicIp = "192.168.1.138";
        const { localDialHost } = await load();
        expect(await localDialHost()).toBe("host.docker.internal");
    });

    it("falls back to the server's address when no name is configured", async () => {
        state.publicIp = "192.168.1.142";
        const { localDialHost } = await load();
        expect(await localDialHost()).toBe("192.168.1.142");
    });

    it("treats a blank variable as unset rather than as an empty host", async () => {
        process.env.POLARIS_APP_DIAL_HOST = "   ";
        state.publicIp = "192.168.1.142";
        const { localDialHost } = await load();
        expect(await localDialHost()).toBe("192.168.1.142");
    });

    it("answers null when neither is known, so the caller leaves routing alone", async () => {
        const { localDialHost } = await load();
        expect(await localDialHost()).toBeNull();
    });
});

describe("edgeOrigin", () => {
    it("addresses the edge by its name on the shared network", async () => {
        const { edgeOrigin, edgeAddress } = await load();
        expect(edgeOrigin()).toBe("http://traefik:80");
        expect(edgeAddress()).toBe("traefik:80");
    });

    it("stays one value when it is overridden", async () => {
        process.env.POLARIS_EDGE_ORIGIN = "http://edge.example:8080";
        const { edgeOrigin, edgeAddress } = await load();
        expect(edgeOrigin()).toBe("http://edge.example:8080");
        expect(edgeAddress()).toBe("edge.example:8080");
    });
});
