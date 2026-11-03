/**
 * The wire under `tuya-protocol`: a TCP connection to a Tuya device on port
 * 6668, and the datagrams devices announce themselves with.
 *
 * One connection per command, closed when the answer is in. A switch is told
 * something a few times a day, and a socket kept open to every one of them is a
 * heartbeat to send forever and a device that only admits one client at a time
 * (most of them) locked away from its own app. Every step has its own deadline,
 * so a device that went quiet costs seconds, not a hung request.
 *
 * The same address care as the rest of the LAN code: this machine, link-local
 * and reserved ranges are never dialed.
 *
 * Server-only.
 */

import { createSocket } from "node:dgram";
import { randomBytes } from "node:crypto";
import * as protocol from "./tuya-protocol";
import { connect, type Socket } from "node:net";
import { forbiddenAddress } from "./lan-address";

/** How long a connection is given to open, and each answer to arrive. */
const CONNECT_MS = 3_000;
const ANSWER_MS = 5_000;

/** Nothing a switch says comes near this; more is not a switch. */
const MAX_BUFFER = 256 * 1024;

export interface TuyaLanTarget {
    readonly id: string;
    readonly address: string;
    readonly version: protocol.TuyaVersion;
    readonly localKey: string;
}

/** Why a device could not be spoken to locally: not there, or there and not
 *  taking this key (a device re-paired since its key was read). */
export class TuyaLanError extends Error {
    readonly reason: "unreachable" | "key";

    constructor(message: string, reason: TuyaLanError["reason"]) {
        super(message);
        this.name = "TuyaLanError";
        this.reason = reason;
    }
}

export type TuyaConnector = (address: string, port: number) => Socket;

let connector: TuyaConnector = (address, port) => connect({ host: address, port });

/** Replace how connections are opened; for tests. No argument restores it. */
export function setTuyaConnector(next?: TuyaConnector): void {
    connector = next ?? ((address, port) => connect({ host: address, port }));
}

interface Link {
    send(cmd: number, payload: Buffer): void;
    next(accept: (frame: protocol.TuyaFrame) => boolean, ms?: number): Promise<protocol.TuyaFrame>;
    readonly session: protocol.TuyaSession;
}

async function withLink<T>(
    target: TuyaLanTarget,
    run: (link: Link) => Promise<T>,
    answerMs = ANSWER_MS
): Promise<T> {
    if (forbiddenAddress(target.address)) {
        throw new TuyaLanError("That address is not one Polaris dials", "unreachable");
    }
    let localKey: Buffer;
    try {
        localKey = protocol.localKeyBytes(target.localKey);
    } catch {
        throw new TuyaLanError("The device's key is not one Tuya issues", "key");
    }
    const session = protocol.newSession(target.version, localKey);
    const socket = connector(target.address, protocol.TUYA_PORT);
    let buffer = Buffer.alloc(0);
    const frames: protocol.TuyaFrame[] = [];
    let failure: TuyaLanError | null = null;
    let wake: (() => void) | null = null;
    const notify = () => wake?.();

    socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_BUFFER) {
            failure = new TuyaLanError("The device said too much", "unreachable");
            return notify();
        }
        try {
            for (;;) {
                const parsed = protocol.parseFrame(buffer, protocol.parseOptionsFor(session));
                if (!parsed) break;
                frames.push(parsed.frame);
                buffer = parsed.rest;
            }
        } catch {
            failure = new TuyaLanError("The device did not take this key", "key");
        }
        notify();
    });
    socket.on("error", () => {
        failure ??= new TuyaLanError("The device could not be reached", "unreachable");
        notify();
    });
    socket.on("close", () => {
        failure ??= new TuyaLanError("The device closed the connection", "unreachable");
        notify();
    });

    const waitFor = (ready: () => boolean, ms: number, what: string) =>
        new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                wake = null;
                reject(new TuyaLanError(what, "unreachable"));
            }, ms);
            const check = () => {
                if (ready()) {
                    clearTimeout(timer);
                    wake = null;
                    resolve();
                } else if (failure) {
                    clearTimeout(timer);
                    wake = null;
                    reject(failure);
                }
            };
            wake = check;
            check();
        });

    let open = false;
    socket.once("connect", () => {
        open = true;
        notify();
    });

    const link: Link = {
        session,
        send(cmd, payload) {
            socket.write(protocol.encodeMessage(session, cmd, payload));
        },
        async next(accept, ms = answerMs) {
            let found: protocol.TuyaFrame | undefined;
            await waitFor(
                () => {
                    const index = frames.findIndex(accept);
                    if (index < 0) return false;
                    found = frames.splice(index, 1)[0];
                    return true;
                },
                ms,
                "The device did not answer"
            );
            return found!;
        }
    };

    try {
        await waitFor(() => open, Math.min(CONNECT_MS, answerMs), "The device could not be reached");
        if (target.version !== "3.3") {
            const nonce = randomBytes(16);
            socket.write(protocol.negotiationStart(session, nonce));
            const answer = await link.next(
                (frame) => frame.cmd === protocol.TUYA_CMD.SESS_KEY_NEG_RESP
            );
            try {
                socket.write(protocol.negotiationFinish(session, nonce, answer));
            } catch {
                throw new TuyaLanError("The device did not take this key", "key");
            }
        }
        return await run(link);
    } finally {
        socket.destroy();
    }
}

/** Once more on a connection that failed to open or went quiet; never on a
 *  key the device refused, which a second try does not change. */
async function twice<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof TuyaLanError && caught.reason === "key") throw caught;
        return run();
    }
}

const STATUS_CMDS: ReadonlySet<number> = new Set([
    protocol.TUYA_CMD.DP_QUERY,
    protocol.TUYA_CMD.DP_QUERY_NEW,
    protocol.TUYA_CMD.STATUS
]);

function dpsIn(link: Link, frame: protocol.TuyaFrame): Record<string, unknown> | null {
    try {
        return protocol.dpsOf(protocol.decodePayload(link.session, frame));
    } catch {
        throw new TuyaLanError("The device did not take this key", "key");
    }
}

/** How long a guess at which device is at an address is given: one try, a
 *  short wait. A wrong guess is a device that says nothing. */
const GUESS_MS = 1_500;

/** Every data point the device has now, by number. `guess` for asking an
 *  address whether it is this device at all. */
export function readTuyaLocal(
    target: TuyaLanTarget,
    options: { readonly guess?: boolean } = {}
): Promise<Record<string, unknown>> {
    const attempt = () =>
        withLink(
            target,
            async (link) => {
            const { cmd, payload } = protocol.queryMessage(link.session, target.id);
            link.send(cmd, payload);
            let dps: Record<string, unknown> | null = null;
            await link.next((frame) => {
                if (!STATUS_CMDS.has(frame.cmd)) return false;
                dps = dpsIn(link, frame);
                return dps !== null;
            });
            return dps!;
            },
            options.guess ? GUESS_MS : ANSWER_MS
        );
    return options.guess ? attempt() : twice(attempt);
}

/** Set data points, by number; resolves once the device has acknowledged. */
export function writeTuyaLocal(
    target: TuyaLanTarget,
    dps: Readonly<Record<string, unknown>>
): Promise<void> {
    return twice(() =>
        withLink(target, async (link) => {
            const { cmd, payload } = protocol.controlMessage(link.session, target.id, dps);
            link.send(cmd, payload);
            const answer = await link.next(
                (frame) => frame.cmd === cmd || frame.cmd === protocol.TUYA_CMD.STATUS
            );
            if (answer.retcode !== null && answer.retcode !== 0) {
                throw new TuyaLanError("The device refused that", "key");
            }
        })
    );
}

/**
 * Every device that announced itself within the window. Devices broadcast every
 * few seconds; what arrives depends on Polaris sharing the LAN's broadcast
 * domain, which a container on a bridge network does not - `probeTuyaPorts`
 * is the way in from there.
 */
export async function listenForTuya(windowMs = 6_000): Promise<protocol.TuyaAnnouncement[]> {
    const found = new Map<string, protocol.TuyaAnnouncement>();
    const sockets = protocol.TUYA_DISCOVERY_PORTS.map((port) => {
        const socket = createSocket({ type: "udp4", reuseAddr: true });
        socket.on("error", () => socket.close());
        socket.on("message", (data) => {
            if (data.length > 4096) return;
            const announcement = protocol.parseAnnouncement(data);
            if (announcement && !forbiddenAddress(announcement.address))
                found.set(announcement.id, announcement);
        });
        try {
            socket.bind(port);
        } catch {
            // A port something else holds is a port this scan goes without.
        }
        return socket;
    });
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    for (const socket of sockets) {
        try {
            socket.close();
        } catch {
            // Already closed after an error.
        }
    }
    return [...found.values()];
}

/** Which of these addresses accept a connection on Tuya's port, a few at a
 *  time, each given `timeoutMs`. */
export async function probeTuyaPorts(
    addresses: readonly string[],
    timeoutMs = 400,
    concurrency = 32
): Promise<string[]> {
    const open: string[] = [];
    const queue = addresses.filter((address) => !forbiddenAddress(address));
    const worker = async () => {
        for (let address = queue.shift(); address; address = queue.shift()) {
            const reached = await new Promise<boolean>((resolve) => {
                const socket = connector(address!, protocol.TUYA_PORT);
                const done = (result: boolean) => {
                    clearTimeout(timer);
                    socket.destroy();
                    resolve(result);
                };
                const timer = setTimeout(() => done(false), timeoutMs);
                socket.once("connect", () => done(true));
                socket.once("error", () => done(false));
            });
            if (reached) open.push(address);
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return open;
}
