/**
 * Which port a new server is given, and which ports it must not be given.
 *
 * Two apps binding the same host port is not an error Polaris reports - it is a
 * container that will not start, found when somebody tries to play - so the
 * allocator has to see every port already spoken for. It saw one of the three:
 * the port an app pinned, but not the further ports a pinned app publishes and
 * not the port derived from an app's id. The first gap is the one with a name:
 * two Java servers with crossplay were both handed UDP 19132.
 *
 * The other half is the bound. Every port handed out lands inside a declared
 * block, which is the whole reason a single forwarded range can cover servers
 * that do not exist yet - a port outside it is a port nobody opened.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The applications the database holds, rewritten per test. */
let applications: { id: string; sourceConfig: string }[] = [];
/** The stored blocks, as the settings table would hold them. */
let settings: Record<string, string> = {};

vi.mock("@polaris/db", () => ({
    prisma: { application: { findMany: vi.fn(async () => applications.map((row) => ({ ...row }))) } }
}));
// Derived ports are a hash of the app id in the real thing; here they are stated,
// so a test can put one exactly where it would hurt.
vi.mock("@/lib/deploy-service", () => ({
    hostPortForApp: (id: string) => (id === "derived-on-25565" ? 25565 : 21000)
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: vi.fn(async (key: string) => settings[key] ?? null),
    setSetting: vi.fn(async () => undefined)
}));

const { availableHostPort, takenHostPorts } = await import("@/lib/apps/port-registry");

/** An app that pinned a port, the way an installed game server does. */
function pinned(id: string, hostPort: number, hostProtocol: "tcp" | "udp" = "tcp", extraPorts: unknown[] = []) {
    return {
        id,
        sourceConfig: JSON.stringify({ imageRef: "example", hostPort, hostProtocol, ...(extraPorts.length ? { extraPorts } : {}) })
    };
}

beforeEach(() => {
    applications = [];
    settings = {};
});

describe("what counts as taken", () => {
    it("sees the ports a pinned app also publishes, not just the one it pinned", async () => {
        // The crossplay case: one service, two doors, and the second was invisible.
        applications = [pinned("java-1", 25565, "tcp", [{ host: 19132, container: 19132, protocol: "udp" }])];

        const taken = await takenHostPorts();

        expect(taken.has("tcp:25565")).toBe(true);
        expect(taken.has("udp:19132")).toBe(true);
    });

    it("sees the port derived for an app that pinned none", async () => {
        applications = [{ id: "derived-on-25565", sourceConfig: JSON.stringify({ imageRef: "example" }) }];

        expect((await takenHostPorts()).has("tcp:25565")).toBe(true);
    });

    it("ignores a config it cannot read rather than failing the allocation", async () => {
        applications = [{ id: "broken", sourceConfig: "{not json" }, pinned("java-1", 25565)];

        expect([...(await takenHostPorts())]).toEqual(["tcp:25565"]);
    });
});

describe("handing out a port", () => {
    it("gives the first server the port its players' clients assume", async () => {
        expect(await availableHostPort(25565, "tcp")).toBe(25565);
    });

    it("gives the second server the next one instead of the same one", async () => {
        applications = [pinned("java-1", 25565)];

        expect(await availableHostPort(25565, "tcp")).toBe(25566);
    });

    it("does not hand a second crossplay server the UDP port the first is on", async () => {
        // The bug this file exists for: `extraPorts` was not consulted, so both
        // servers were published on 19132 and the second could not bind.
        applications = [pinned("java-1", 25565, "tcp", [{ host: 19132, container: 19132, protocol: "udp" }])];

        expect(await availableHostPort(19132, "udp")).toBe(19133);
    });

    it("steps over a port an unpinned app already derived", async () => {
        applications = [{ id: "derived-on-25565", sourceConfig: JSON.stringify({ imageRef: "example" }) }];

        expect(await availableHostPort(25565, "tcp")).toBe(25566);
    });

    it("treats TCP and UDP of the same number as different doors", async () => {
        // A Bedrock server on UDP 25565 does not stop a Java server taking TCP 25565.
        applications = [pinned("bedrock-1", 25565, "udp")];

        expect(await availableHostPort(25565, "tcp")).toBe(25565);
    });
});

describe("staying inside the block", () => {
    it("places an app whose preferred port is outside the block inside it", async () => {
        // A game whose canonical port is nowhere near the block - a port outside it
        // is a port the forwarded range does not cover.
        expect(await availableHostPort(7777, "tcp")).toBe(25565);
    });

    it("follows the block the operator widened", async () => {
        settings["network.portBlock.tcp"] = JSON.stringify({ start: 30000, end: 30001 });

        expect(await availableHostPort(7777, "tcp")).toBe(30000);
    });

    it("ignores a stored block that is not one, rather than refusing to allocate", async () => {
        // A block containing 443 would have the game rules fight the website rules.
        settings["network.portBlock.tcp"] = JSON.stringify({ start: 80, end: 500 });

        expect(await availableHostPort(25565, "tcp")).toBe(25565);
    });

    it("says which range filled up, since that is what has to be widened", async () => {
        settings["network.portBlock.tcp"] = JSON.stringify({ start: 30000, end: 30001 });
        applications = [pinned("a", 30000), pinned("b", 30001)];

        await expect(availableHostPort(30000, "tcp")).rejects.toThrow(/30000-30001/);
    });
});
