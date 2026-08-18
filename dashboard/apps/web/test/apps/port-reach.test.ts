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
import { createSocket, type Socket } from "node:dgram";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Every write the probe made, in place of the install row it would patch. */
const patched: { id: string; patch: Record<string, unknown> }[] = [];
let publicIp: string | null = "127.0.0.1";

/** The install the advice is asked about, and the application behind it - the
 *  ports it published and whether Polaris means it to be up. */
let install: { applicationId: string | null; config: string | null } = { applicationId: "app", config: null };
let application: { sourceConfig: string; desiredState: string } | null = null;

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: { findUnique: async () => install },
        application: { findUnique: async () => application }
    }
}));
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
vi.mock("@/lib/host-address", async (importActual) => ({
    ...(await importActual<typeof import("@/lib/host-address")>()),
    // The probe dials the address this machine holds on its own network, which a
    // test cannot have. Everything else - what counts as a LAN address, which is
    // what decides whether a join proves anything - keeps the real rule.
    getHostLanIp: async () => "127.0.0.1"
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

const { noteReachedFrom, probeListening, probeReach, reachAdviceFor } = await import(
    "@/lib/apps/minecraft/reach"
);
const { probeTcpPort } = await import("@/lib/net/port-probe");

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

/** The constant every RakNet offline packet carries. */
const MAGIC = Buffer.from([
    0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78
]);

/**
 * A UDP port that answers like a Bedrock server, or like anything else.
 *
 * `speaks` is the whole point of having both: a port that replies without the
 * magic is some other service sitting on the number, and taking that as proof
 * would clear the warning for an operator whose game is not reachable at all.
 */
async function bedrock(speaks: "raknet" | "gibberish"): Promise<{ port: number; socket: Socket }> {
    const socket = createSocket("udp4");
    socket.on("message", (message, from) => {
        if (message.readUInt8(0) !== 0x01) return;
        if (speaks === "gibberish") {
            socket.send(Buffer.from("not a pong"), from.port, from.address);
            return;
        }
        const pong = Buffer.alloc(1 + 8 + 8 + MAGIC.length + 2);
        pong.writeUInt8(0x1c, 0);
        message.copy(pong, 1, 1, 9);
        MAGIC.copy(pong, 17);
        socket.send(pong, from.port, from.address);
    });
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
    return { port: socket.address().port, socket };
}

function closeSocket(socket: Socket): Promise<void> {
    return new Promise((resolve) => socket.close(() => resolve()));
}

/** A status reply as a Java server frames it: the length of what follows, the
 *  packet id, then the JSON row a client would draw on its server list. */
function statusReply(): Buffer {
    const json = Buffer.from('{"description":"a server"}', "utf8");
    const body = Buffer.concat([Buffer.from([0x00, json.length]), json]);
    return Buffer.concat([Buffer.from([body.length]), body]);
}

/**
 * A TCP port that answers like a Java server, or like the two things that are not
 * one.
 *
 * `silence` is the case this whole probe exists for: the container engine publishes
 * the host port the moment the container exists and accepts on the server's behalf,
 * so a port with no game behind it opens cleanly and says nothing. Reading that as
 * a running server is what sent an operator into their router about a server that
 * had not started yet.
 */
async function java(speaks: "status" | "silence" | "gibberish"): Promise<{ port: number; server: Server }> {
    const server = createServer((socket) => {
        // The probe hangs up the moment it has its answer, and a hang-up on a
        // request this side never read is a reset - which is an error event with
        // nobody listening, and that ends the run rather than the connection.
        socket.on("error", () => socket.destroy());
        if (speaks === "silence") {
            // Read the request and answer nothing, which is what a published port
            // with no game behind it does. Left unread, the request would hold the
            // socket open against the hang-up and the listener could never close.
            socket.resume();
            return;
        }
        socket.once("data", () => socket.write(speaks === "status" ? statusReply() : Buffer.from("HTTP/1.1 200 OK")));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return { port: address.port, server };
}

afterEach(() => {
    patched.length = 0;
    publicIp = "127.0.0.1";
    install = { applicationId: "app", config: null };
    application = null;
});

describe("knocking on a single port", () => {
    it("reports the port that answers, and only that", async () => {
        const { port, server } = await listener();

        expect(await probeTcpPort("127.0.0.1", port)).toBe(true);
        await close(server);
        // Nothing is listening now, so the same call has to come back false - a
        // probe that keeps saying yes is worse than one that never says it.
        expect(await probeTcpPort("127.0.0.1", port)).toBe(false);
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

    it("proves a UDP port when a Bedrock server answers on it", async () => {
        const { port, socket } = await bedrock("raknet");

        // Without this a Bedrock server could never be proven at all: UDP was
        // skipped here and its log prints no player address either, so the panel
        // asked for a forward that already existed and never took it back.
        expect(await probeReach([{ installedAppId: "bedrock", ports: [{ port, protocol: "udp" }] }])).toEqual([
            "bedrock"
        ]);
        expect(patched).toHaveLength(1);
        await closeSocket(socket);
    });

    it("refuses a UDP answer that is not RakNet", async () => {
        const { port, socket } = await bedrock("gibberish");

        // Something replied, which is exactly the trap: only a packet carrying
        // RakNet's magic came from the game server the operator is asking about.
        expect(await probeReach([{ installedAppId: "impostor", ports: [{ port, protocol: "udp" }] }])).toEqual([]);
        expect(patched).toEqual([]);
        await closeSocket(socket);
    });

    it("stays silent on a UDP port that answers nothing", async () => {
        const { port, server } = await listener();

        expect(await probeReach([{ installedAppId: "quiet", ports: [{ port, protocol: "udp" }] }])).toEqual([]);
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

describe("what a server that is turned off is told", () => {
    /** A Bedrock server: UDP only, which is the case silence says nothing about. */
    const bedrockPorts = JSON.stringify({ hostPort: 19132, hostProtocol: "udp" });

    it("does not knock on it, and refuses to name the router", async () => {
        application = { sourceConfig: bedrockPorts, desiredState: "stopped" };

        const advice = await reachAdviceFor("off", true);

        // The bug this exists for: a stopped server answers nothing, the knock
        // fails for that reason alone, and the operator was sent to re-open a port
        // that had been forwarded for months.
        expect(advice.forward).toBe(false);
        expect(advice.actionable).toBe(false);
        expect(advice.title).toContain("cannot be checked");
        expect(patched).toEqual([]);
    });
});

/**
 * The same refusal one step later, and the state a brand new server spends its
 * first minutes in: Polaris means it to be up, and the game has not opened its
 * world yet.
 */
describe("what a server that has not finished starting is told", () => {
    it("refuses to name the router while the port is published but silent", async () => {
        const { port, server } = await java("silence");
        application = {
            sourceConfig: JSON.stringify({ hostPort: port, hostProtocol: "tcp" }),
            desiredState: "running"
        };

        const advice = await reachAdviceFor("starting");

        // What the operator saw on a server they had just created: an open socket
        // held by the engine on behalf of a game that was still fetching itself,
        // read as a running server, read in turn as a router that had not been
        // told about it.
        expect(advice.forward).toBe(false);
        expect(advice.actionable).toBe(false);
        expect(advice.title).toContain("Not answering yet");
        await close(server);
    });

    it("asks about the forward once the game itself answers", async () => {
        const { port, server } = await java("status");
        application = {
            sourceConfig: JSON.stringify({ hostPort: port, hostProtocol: "tcp" }),
            desiredState: "running"
        };

        const advice = await reachAdviceFor("up");

        expect(advice.forward).toBe(true);
        expect(advice.title).toContain("not confirmed");
        await close(server);
    });
});

describe("whether the game is answering here", () => {
    it("hears a Java server, and not a port that merely accepts", async () => {
        const answering = await java("status");
        const published = await java("silence");
        const impostor = await java("gibberish");

        expect(await probeListening([{ port: answering.port, protocol: "tcp" }], "127.0.0.1")).toBe(true);
        // This is the state that used to be read as "your router is not forwarding
        // it": the port is held and open, and nothing is playing Minecraft behind
        // it. Something answered on the third, and it was not the game.
        expect(await probeListening([{ port: published.port, protocol: "tcp" }], "127.0.0.1")).toBe(false);
        expect(await probeListening([{ port: impostor.port, protocol: "tcp" }], "127.0.0.1")).toBe(false);
        await Promise.all([close(answering.server), close(published.server), close(impostor.server)]);
    });

    it("hears a Bedrock server on UDP, and nothing else", async () => {
        const { port, socket } = await bedrock("raknet");

        expect(await probeListening([{ port, protocol: "udp" }], "127.0.0.1")).toBe(true);
        await closeSocket(socket);
        // Silence on the way out means nothing - a router that will not loop its
        // own address back inward sounds the same. Silence here is the game not
        // answering, since there is nothing in between to lose the packet.
        expect(await probeListening([{ port, protocol: "udp" }], "127.0.0.1")).toBe(false);
        // And a server with no ports is not handed a verdict about them.
        expect(await probeListening([], "127.0.0.1")).toBeNull();
    });

    it("answers on the port that is up when a server publishes several", async () => {
        const { port, socket } = await bedrock("raknet");
        const quiet = await java("silence");

        // ARK publishes three and only the query port ever replies; a game that
        // answered on any of them is up.
        expect(
            await probeListening(
                [
                    { port: quiet.port, protocol: "tcp" },
                    { port, protocol: "udp" }
                ],
                "127.0.0.1"
            )
        ).toBe(true);
        await closeSocket(socket);
        await close(quiet.server);
    });
});
