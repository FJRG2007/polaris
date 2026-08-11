/**
 * Proving an ARK server's port from outside.
 *
 * This is the only positive evidence an ARK server can produce. Its game port
 * answers nobody who is not already playing, and unlike Minecraft nothing here
 * reads a player's address out of its log - so before the query below existed, a
 * server could be listed in Steam with people on it while Polaris kept telling its
 * owner to go and open a port that had been open for weeks.
 */

import { createSocket } from "node:dgram";
import { pingSteamQuery } from "@/lib/apps/ark/a2s";
import { afterEach, describe, expect, it } from "vitest";

/** Answer one A2S query the way a Steam server does, and hand back the port it is
 *  listening on. */
function fakeQueryPort(reply: Buffer): Promise<{ port: number; close: () => void }> {
    const socket = createSocket("udp4");
    socket.on("message", (_message, from) => {
        socket.send(reply, from.port, from.address);
    });
    return new Promise((resolve) => {
        socket.bind(0, "127.0.0.1", () =>
            resolve({ port: socket.address().port, close: () => socket.close() })
        );
    });
}

let close: (() => void) | null = null;

afterEach(() => {
    close?.();
    close = null;
});

describe("pingSteamQuery", () => {
    it("takes a server describing itself as an answer", async () => {
        const server = await fakeQueryPort(
            Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49]), Buffer.from("Ragnarok\0", "latin1")])
        );
        close = server.close;

        expect(await pingSteamQuery("127.0.0.1", server.port, 2000)).toBe(true);
    });

    it("takes a challenge as an answer too", async () => {
        // Since Valve's anti-reflection change a server often replies with a
        // challenge to be asked again with. It is a different packet and the same
        // proof: it made the round trip.
        const server = await fakeQueryPort(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 0x11, 0x22, 0x33, 0x44]));
        close = server.close;

        expect(await pingSteamQuery("127.0.0.1", server.port, 2000)).toBe(true);
    });

    it("does not take whatever else was on the port as an answer", async () => {
        const server = await fakeQueryPort(Buffer.from("HTTP/1.1 400 Bad Request\r\n", "latin1"));
        close = server.close;

        expect(await pingSteamQuery("127.0.0.1", server.port, 700)).toBe(false);
    });

    it("reads silence as nothing at all rather than as a closed port", async () => {
        // Nothing is bound here. False is the answer, and it is deliberately not a
        // claim that the port is shut - see the module.
        expect(await pingSteamQuery("127.0.0.1", 19199, 500)).toBe(false);
    });
});
