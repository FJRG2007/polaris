/**
 * Handing out several ports at once.
 *
 * A game whose doors are arithmetically tied to each other cannot allocate them one
 * at a time: nothing is recorded until the application exists, so the second call
 * would be handed the port the first just took. ARK is that game - its raw socket
 * has to be exactly one above its game port on the player's side of the mapping -
 * and a run that steps over an occupied port in the middle is a server that will
 * not bind.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The applications the database holds, rewritten per test. */
let applications: { id: string; sourceConfig: string }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: { application: { findMany: vi.fn(async () => applications.map((row) => ({ ...row }))) } }
}));
vi.mock("@/lib/deploy-service", () => ({ hostPortForApp: () => 21000 }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn(async () => undefined)
}));

const { availableHostPort, availableHostPortRun } = await import("@/lib/apps/port-registry");

/** An app that pinned a port, the way an installed game server does. */
function pinned(id: string, hostPort: number, extraPorts: unknown[] = []) {
    return {
        id,
        sourceConfig: JSON.stringify({
            imageRef: "example",
            hostPort,
            hostProtocol: "udp",
            ...(extraPorts.length ? { extraPorts } : {})
        })
    };
}

beforeEach(() => {
    applications = [];
});

describe("a run of ports", () => {
    it("starts where the game asks when the whole run is free", async () => {
        // ARK's own ports are outside the UDP block, so the run lands at its start.
        expect(await availableHostPortRun(7777, 3, "udp")).toBe(19132);
    });

    it("steps past a run with an occupied port in the middle", async () => {
        applications = [pinned("taken", 19133)];
        expect(await availableHostPortRun(7777, 3, "udp")).toBe(19134);
    });

    it("leaves room for the server that already has one", async () => {
        // A first ARK server holding 19132-19134, published as a pinned port and
        // two extras, is exactly the shape the second one has to see.
        applications = [
            pinned("first", 19132, [
                { host: 19133, container: 19133, protocol: "udp" },
                { host: 19134, container: 19134, protocol: "udp" }
            ])
        ];
        expect(await availableHostPortRun(7777, 3, "udp")).toBe(19135);
    });

    it("refuses rather than handing out a run that leaves the block", async () => {
        // The default UDP block is a hundred wide; fill it from 19132 to the end.
        applications = Array.from({ length: 100 }, (_, index) => pinned(`app-${index}`, 19132 + index));
        await expect(availableHostPortRun(7777, 3, "udp")).rejects.toThrow(/No run of 3 free ports/);
    });

    it("is what a single port goes through too, so both agree", async () => {
        applications = [pinned("taken", 19132)];
        expect(await availableHostPort(19132, "udp")).toBe(19133);
    });
});
