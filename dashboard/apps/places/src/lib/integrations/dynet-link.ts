/**
 * The TCP link to a Dynalite Ethernet gateway: connect, send messages, hear
 * what the network says for a moment, close.
 *
 * Its own file so the driver can be tested without a network: the tests
 * replace this module with a gateway made of fixtures.
 *
 * A link per call rather than one held open: a sync asks a handful of areas
 * and listens briefly, and a command is one message. The gateways take more
 * than one client, so the installer's own tools are not pushed off.
 *
 * Server-only.
 */

import { Socket, isIP } from "node:net";
import { DriverError } from "../drivers/contract";
import { decodeDynet, type DynetMessage } from "./dynet";
import { forbiddenAddress, forbiddenError, guardedLookup } from "./lan-address";

/** How long a gateway has to accept the connection. */
const CONNECT_MS = 5_000;
/** Between two messages written. */
const WRITE_GAP_MS = 40;
/** Nothing a gateway sends in one listen is anywhere near this. */
const MAX_BYTES = 64 * 1024;

/**
 * Send `messages` to the gateway, one after another, and collect every
 * logical message heard until `listenMs` after the last one was written.
 */
export function dynetExchange(
    host: string,
    port: number,
    messages: readonly Buffer[],
    listenMs: number
): Promise<DynetMessage[]> {
    return new Promise((resolve, reject) => {
        const socket = new Socket();
        const heard: DynetMessage[] = [];
        let buffer = Buffer.alloc(0);
        let received = 0;
        let settled = false;
        const finish = (error?: DriverError) => {
            if (settled) return;
            settled = true;
            clearTimeout(connectTimer);
            socket.destroy();
            if (error) reject(error);
            else resolve(heard);
        };
        const connectTimer = setTimeout(
            () =>
                finish(
                    new DriverError("The Dynalite gateway did not answer in time.", "unreachable")
                ),
            CONNECT_MS
        );
        socket.setNoDelay(true);
        socket.once("error", (error: NodeJS.ErrnoException) =>
            finish(
                error.code === "ENOTFOUND" || error.code === "EAI_AGAIN"
                    ? new DriverError(
                          "That address could not be found on this network.",
                          "unreachable"
                      )
                    : new DriverError(
                          "Nothing answered on that address and port. Check the gateway's address and that its port is 12345 unless it was changed.",
                          "unreachable"
                      )
            )
        );
        socket.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_BYTES) return finish();
            const decoded = decodeDynet(Buffer.concat([buffer, chunk]));
            heard.push(...decoded.messages);
            buffer = Buffer.from(decoded.rest);
        });
        const bare = host.replace(/^\[|\]$/g, "");
        if (isIP(bare) && forbiddenAddress(bare)) {
            finish(forbiddenError());
            return;
        }
        socket.connect({ port, host: bare, lookup: guardedLookup }, () => {
            clearTimeout(connectTimer);
            // Spaced out: the bus behind the gateway runs at 9600 baud, and a
            // burst of requests outruns its buffer.
            messages.forEach((message, index) =>
                setTimeout(() => {
                    if (!settled) socket.write(message);
                }, index * WRITE_GAP_MS)
            );
            setTimeout(() => finish(), messages.length * WRITE_GAP_MS + listenMs);
        });
    });
}
