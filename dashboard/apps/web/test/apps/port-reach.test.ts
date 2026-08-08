/**
 * Proving a game port from inside the network.
 *
 * The dangerous outcome here is a false yes: clearing the warning for an operator
 * whose forward does not exist sends them to tell their friends the server is up.
 * So what is asserted is mostly what the probe refuses to do - knock on an address
 * the internet could not dial, knock again inside the rate limit, or conclude
 * anything at all from a transport it cannot hear.
 */

import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Every write the probe made, in place of the install row it would patch. */
const patched: { id: string; patch: Record<string, unknown> }[] = [];
let publicIp: string | null = "127.0.0.1";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/network-service", () => ({
    detectPublicIp: async () => publicIp,
    getLocalEnvironment: async () => ({ environment: "home-nat", detected: "home-nat", confirmed: true })
}));
vi.mock("@/lib/apps/install-config", () => ({
    patchInstallConfig: async (id: string, patch: Record<string, unknown>) => {
        patched.push({ id, patch });
    },
    readInstallConfig: () => ({})
}));
vi.mock("@/lib/apps/port-block-store", () => ({
    getPortPolicy: async () => "range",
    getPortBlocks: async () => ({ tcp: { start: 25565, end: 25664 }, udp: { start: 19132, end: 19231 } })
}));
vi.mock("@polaris/core", async (importActual) => ({
    ...(await importActual<typeof import("@polaris/core")>()),
    // A test cannot hold an address the internet could dial, so the loopback
    // listener stands in for one. Everything else keeps the real rule.
    isPublicIpv4: (value: string) => value === "127.0.0.1"
}));

const { noteReachedFrom, probeGamePort, probeReach } = await import("@/lib/apps/minecraft/reach");

/** A port with something listening on it, and the same port once nothing is. */
async function listener(): Promise<{ port: number; server: Server }> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return { port: address.port, server };
}

function close(server: Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

afterEach(() => {
    patched.length = 0;
    publicIp = "127.0.0.1";
});

describe("knocking on a single port", () => {
    it("reports the port that answers, and only that", async () => {
        const { port, server } = await listener();

        expect(await probeGamePort("127.0.0.1", port)).toBe(true);
        await close(server);
        // Nothing is listening now, so the same call has to come back false - a
        // probe that keeps saying yes is worse than one that never says it.
        expect(await probeGamePort("127.0.0.1", port)).toBe(false);
    });
});

describe("proving a server's ports", () => {
    it("records the install when its port answers from the outside address", async () => {
        const { port, server } = await listener();

        expect(await probeReach([{ installedAppId: "answers", ports: [{ port, protocol: "tcp" }] }])).toEqual([
            "answers"
        ]);
        expect(patched).toHaveLength(1);
        expect(patched[0]?.id).toBe("answers");
        expect(typeof patched[0]?.patch.portReachableAt).toBe("string");
        await close(server);
    });

    it("does not knock again inside the rate limit", async () => {
        const { port, server } = await listener();
        const entry = { installedAppId: "twice", ports: [{ port, protocol: "tcp" as const }] };

        expect(await probeReach([entry])).toEqual(["twice"]);
        // A page left open polls every few seconds, and two open pages poll twice as
        // often; one attempt has to cover them all.
        expect(await probeReach([entry])).toEqual([]);
        expect(patched).toHaveLength(1);
        await close(server);
    });

    it("stays silent on UDP, where a blocked port and an open one sound the same", async () => {
        const { port, server } = await listener();

        expect(await probeReach([{ installedAppId: "bedrock", ports: [{ port, protocol: "udp" }] }])).toEqual([]);
        expect(patched).toEqual([]);
        await close(server);
    });

    it("knocks on nothing when this line has no address of its own", async () => {
        const { port, server } = await listener();
        publicIp = "192.168.1.142";

        // The forward is exactly what is in question, so a probe that never leaves
        // the network can only ever answer the wrong question.
        expect(await probeReach([{ installedAppId: "natted", ports: [{ port, protocol: "tcp" }] }])).toEqual([]);
        expect(patched).toEqual([]);
        await close(server);
    });
});

describe("recording what arrived", () => {
    it("refuses a join from this same network", async () => {
        // The one case where it means nothing: the operator testing from their own
        // desk never went near the router.
        expect(await noteReachedFrom("desk", "192.168.1.50")).toBe(false);
        expect(patched).toEqual([]);
    });

    it("takes one from a public address", async () => {
        expect(await noteReachedFrom("player", "203.0.113.9")).toBe(true);
        expect(patched[0]?.id).toBe("player");
    });
});
