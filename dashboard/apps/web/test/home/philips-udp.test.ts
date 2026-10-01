/**
 * The Philips transport on real sockets, against a unit played by a socket on
 * this machine's loopback: an answer is matched by its token, a confirmable one
 * is acknowledged as aiocoap acknowledges it, a notification nobody waits for
 * reaches the listener, and a scan collects the answers of the addresses it
 * wrote to.
 */

import { createSocket, type Socket } from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { coapScan, openCoapLink } from "@polaris-app/places/src/lib/integrations/philips-udp";
import {
    CoapCode,
    CoapType,
    decodeCoap,
    encodeCoap,
    type CoapMessage
} from "@polaris-app/places/src/lib/integrations/coap";

let unit: Socket | null = null;

afterEach(() => {
    unit?.close();
    unit = null;
});

/** A unit on the loopback that answers each request through `respond`, and
 *  records everything it hears. */
async function playUnit(
    respond: (request: CoapMessage) => CoapMessage[]
): Promise<{ port: number; heard: CoapMessage[] }> {
    const heard: CoapMessage[] = [];
    const socket = createSocket({ type: "udp4" });
    unit = socket;
    socket.on("message", (data, from) => {
        const message = decodeCoap(data);
        if (!message) return;
        heard.push(message);
        for (const out of respond(message)) socket.send(encodeCoap(out), from.port, from.address);
    });
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
    return { port: socket.address().port, heard };
}

const request = (token: string, path: string[], observe?: number): CoapMessage => ({
    type: CoapType.NON,
    code: CoapCode.GET,
    messageId: 7,
    token: Buffer.from(token, "hex"),
    path,
    ...(observe !== undefined ? { observe } : {})
});

describe("a link to one unit", () => {
    it("takes the answer that carries its token and acknowledges a confirmable one", async () => {
        const { port, heard } = await playUnit((message) =>
            message.code === CoapCode.GET
                ? [
                      // Somebody else's token first: never taken for this answer.
                      {
                          type: CoapType.NON,
                          code: CoapCode.CONTENT,
                          messageId: 40,
                          token: Buffer.from("ffffffff", "hex"),
                          payload: Buffer.from("no")
                      },
                      {
                          type: CoapType.CON,
                          code: CoapCode.CONTENT,
                          messageId: 41,
                          token: message.token,
                          payload: Buffer.from("yes")
                      }
                  ]
                : []
        );
        const link = await openCoapLink("127.0.0.1", port);
        try {
            link.send(request("01020304", ["sys", "dev", "info"]));
            const answer = await link.next(
                (message) => message.token.equals(Buffer.from("01020304", "hex")),
                2000
            );
            expect(answer?.payload?.toString()).toBe("yes");
            await new Promise((resolve) => setTimeout(resolve, 100));
            const ack = heard.find((message) => message.type === CoapType.ACK);
            expect(ack).toMatchObject({ code: CoapCode.EMPTY, messageId: 41 });
            expect(ack?.token.length).toBe(0);
        } finally {
            link.close();
        }
    });

    it("hands notifications nobody waits for to the listener", async () => {
        const { port } = await playUnit((message) =>
            message.observe === 0
                ? [1, 2].map((sequence) => ({
                      type: CoapType.NON,
                      code: CoapCode.CONTENT,
                      messageId: 50 + sequence,
                      token: message.token,
                      observe: sequence,
                      payload: Buffer.from(`push ${sequence}`)
                  }))
                : []
        );
        const link = await openCoapLink("127.0.0.1", port);
        const pushed: string[] = [];
        try {
            link.onUnclaimed((message) => pushed.push(message.payload?.toString() ?? ""));
            link.send(request("0a0b0c0d", ["sys", "dev", "status"], 0));
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(pushed).toEqual(["push 1", "push 2"]);
        } finally {
            link.close();
        }
    });

    it("gives up on an answer that never comes", async () => {
        const { port } = await playUnit(() => []);
        const link = await openCoapLink("127.0.0.1", port);
        try {
            link.send(request("01020304", ["sys", "dev", "sync"]));
            expect(await link.next(() => true, 150)).toBeNull();
        } finally {
            link.close();
        }
    });
});

describe("a scan", () => {
    it("collects what the addresses it wrote to say", async () => {
        const { port } = await playUnit((message) => [
            {
                type: CoapType.NON,
                code: CoapCode.CONTENT,
                messageId: 9,
                token: message.token,
                payload: Buffer.from('{"modelid":"AC3829/10"}')
            }
        ]);
        const replies = await coapScan(
            ["127.0.0.1"],
            request("01020304", ["sys", "dev", "info"]),
            300,
            port
        );
        expect(replies).toHaveLength(1);
        expect(replies[0]!.address).toBe("127.0.0.1");
        expect(replies[0]!.message.payload?.toString()).toBe('{"modelid":"AC3829/10"}');
    });
});
