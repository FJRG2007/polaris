/**
 * A forwarded port that only one caller may use.
 *
 * The Deploy panel's copy from a database reached through SSH runs the dump
 * inside the destination's container, which cannot reach the dashboard's
 * loopback. So the port is opened on the network the two share - and a door
 * into somebody's network on a network other containers sit on too must open
 * for that one container and nothing else.
 */

import type { Client } from "ssh2";
import { PassThrough } from "node:stream";
import { connect, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { listenForward } from "../src/forward.js";

/** An SSH client whose forwarded channels answer every write with an echo. */
function echoClient() {
    const forwardOut = vi.fn(
        (
            _sh: string,
            _sp: number,
            _dh: string,
            _dp: number,
            done: (error: Error | undefined, channel: unknown) => void
        ) => {
            const channel = new PassThrough() as PassThrough & { close: () => void };
            channel.close = () => channel.destroy();
            done(undefined, channel);
        }
    );
    return { client: { forwardOut } as unknown as Client, forwardOut };
}

function talk(port: number): Promise<string> {
    return new Promise((resolve) => {
        const socket: Socket = connect(port, "127.0.0.1", () => socket.write("ping"));
        let said = "";
        socket.on("data", (chunk) => {
            said += chunk.toString();
            socket.end();
        });
        socket.on("close", () => resolve(said));
        socket.on("error", () => resolve(said));
    });
}

describe("a forwarded port", () => {
    it("passes a caller it was opened for", async () => {
        const { client, forwardOut } = echoClient();
        const forward = await listenForward(client, "db", 5432, undefined, {
            bindHost: "127.0.0.1",
            allowFrom: "127.0.0.1"
        });
        expect(await talk(forward.port)).toBe("ping");
        expect(forwardOut).toHaveBeenCalledTimes(1);
        forward.close();
    });

    it("drops anybody else before a channel is opened", async () => {
        const { client, forwardOut } = echoClient();
        const forward = await listenForward(client, "db", 5432, undefined, {
            bindHost: "127.0.0.1",
            allowFrom: "10.9.9.9"
        });
        expect(await talk(forward.port)).toBe("");
        expect(forwardOut).not.toHaveBeenCalled();
        forward.close();
    });

    it("says where it listens", async () => {
        const { client } = echoClient();
        const forward = await listenForward(client, "db", 5432);
        expect(forward.host).toBe("127.0.0.1");
        forward.close();
    });
});
