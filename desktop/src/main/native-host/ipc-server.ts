/**
 * The local socket the native messaging host connects to (`ipc-path`).
 *
 * One message per connection (`protocol`), answered once, then closed. A
 * connection that says nothing for a few seconds, or more than one message, is
 * closed. On macOS and Linux the folder is created 0700 and checked to belong
 * to this user before anything listens in it; a folder that does not is left
 * alone and nothing listens.
 */

import type { Endpoint } from "./ipc-path";
import { frame, readFrame, type PairMessage } from "./protocol";
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { NativePairReply } from "../../../../dashboard/packages/core/src/device-pairing";

/** How long a connection may take to send its message. */
const READ_TIMEOUT_MS = 5_000;

/** Make the socket's folder private to this user, or say why it cannot be. */
function preparePrivateDir(dir: string): string | null {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "is not a folder";
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return "belongs to another user";
    if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
    return null;
}

/** Answer one connection. */
export function serveConnection(socket: Socket, handle: (message: PairMessage) => Promise<NativePairReply>): void {
    let received = Buffer.alloc(0);
    let answered = false;
    const answer = (reply: NativePairReply) => {
        if (answered) return;
        answered = true;
        socket.end(frame(reply));
    };
    socket.setTimeout(READ_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
        if (answered) return;
        received = Buffer.concat([received, chunk]);
        const read = readFrame(received);
        if (read.kind === "partial") return;
        if (read.kind === "invalid") {
            console.warn(`polaris: native host message refused: ${read.why}`);
            answer({ ok: false, reason: "bad-request" });
            return;
        }
        socket.setTimeout(0);
        handle(read.message).then(answer, (error: unknown) => {
            console.error("polaris: pairing with the extension failed:", error);
            answer({ ok: false, reason: "unreachable" });
        });
    });
}

/** Listen at the endpoint; null when it could not (logged, never thrown). */
export async function listen(endpoint: Endpoint, handle: (message: PairMessage) => Promise<NativePairReply>): Promise<Server | null> {
    try {
        if (endpoint.dir) {
            const problem = preparePrivateDir(endpoint.dir);
            if (problem) {
                console.warn(`polaris: the native host folder ${problem}; extension pairing is off`);
                return null;
            }
            // A socket left by an earlier run that did not close; only one app
            // runs at a time (the single-instance lock).
            rmSync(endpoint.path, { force: true });
        }
        const server = createServer((socket) => serveConnection(socket, handle));
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(endpoint.path, () => {
                server.off("error", reject);
                resolve();
            });
        });
        if (endpoint.dir) chmodSync(endpoint.path, 0o600);
        server.on("error", (error) => console.error("polaris: native host socket:", error));
        return server;
    } catch (error) {
        console.warn("polaris: could not listen for the extension; pairing is off:", error);
        return null;
    }
}
