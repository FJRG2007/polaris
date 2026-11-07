/**
 * The little of the ADB wire protocol that installing on a TV needs: connect,
 * authenticate, run a shell command, push a file. Spoken directly over TCP so
 * nobody has to install platform-tools.
 *
 * Protocol as AOSP documents it (packages/modules/adb, protocol.txt and
 * SYNC.TXT). Over TCP, or over any other link that carries the same packets - a
 * USB cable's bulk endpoints (`usb-link.ts`). Android 11's Wireless debugging
 * pairing is another protocol, which this does not speak.
 */

import { connect as tcp, type Socket } from "node:net";
import { createPublicKey, generateKeyPairSync, privateEncrypt, constants, type KeyObject } from "node:crypto";

const A_CNXN = 0x4e584e43;
const A_AUTH = 0x48545541;
const A_OPEN = 0x4e45504f;
const A_OKAY = 0x59414b4f;
const A_CLSE = 0x45534c43;
const A_WRTE = 0x45545257;
const VERSION = 0x01000000;
const MAX_PAYLOAD = 4096;
const AUTH_TOKEN = 1;
const AUTH_SIGNATURE = 2;
const AUTH_PUBLIC_KEY = 3;
const HEADER_BYTES = 24;
const MAX_INBOUND = 1024 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const SYNC_CHUNK = 64 * 1024;
/** DigestInfo for SHA-1: ADB's token stands in for the digest itself. */
const SHA1_PREFIX = Buffer.from("3021300906052b0e03021a05000414", "hex");

export interface Packet {
    readonly command: number;
    readonly arg0: number;
    readonly arg1: number;
    readonly data: Buffer;
}

export function encodePacket(command: number, arg0: number, arg1: number, data: Buffer = Buffer.alloc(0)): Buffer {
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32LE(command, 0);
    header.writeUInt32LE(arg0, 4);
    header.writeUInt32LE(arg1, 8);
    header.writeUInt32LE(data.length, 12);
    let sum = 0;
    for (const byte of data) sum = (sum + byte) >>> 0;
    header.writeUInt32LE(sum, 16);
    header.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
    return Buffer.concat([header, data]);
}

/** Packets read off a stream that hands them over in arbitrary pieces. */
export class PacketReader {
    private pending = Buffer.alloc(0);

    push(chunk: Buffer): Packet[] {
        this.pending = Buffer.concat([this.pending, chunk]);
        const packets: Packet[] = [];
        while (this.pending.length >= HEADER_BYTES) {
            const length = this.pending.readUInt32LE(12);
            const command = this.pending.readUInt32LE(0);
            const magic = this.pending.readUInt32LE(20);
            if (((command ^ 0xffffffff) >>> 0) !== magic || length > MAX_INBOUND) {
                throw new Error("That address does not speak ADB.");
            }
            if (this.pending.length < HEADER_BYTES + length) break;
            packets.push({
                command,
                arg0: this.pending.readUInt32LE(4),
                arg1: this.pending.readUInt32LE(8),
                data: this.pending.subarray(HEADER_BYTES, HEADER_BYTES + length)
            });
            this.pending = this.pending.subarray(HEADER_BYTES + length);
        }
        return packets;
    }
}

export function newAdbKey(): string {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function wordsOf(value: bigint, count: number): Buffer {
    const out = Buffer.alloc(count * 4);
    let rest = value;
    for (let index = 0; index < count; index += 1) {
        out.writeUInt32LE(Number(rest & 0xffffffffn), index * 4);
        rest >>= 32n;
    }
    return out;
}

/** The public key in Android's own format: mincrypt's RSAPublicKey, base64, then a name. */
export function androidPublicKey(key: KeyObject | string, comment = "polaris@desktop"): Buffer {
    const jwk = createPublicKey(key).export({ format: "jwk" });
    const n = BigInt(`0x${Buffer.from(jwk.n ?? "", "base64url").toString("hex")}`);
    const words = 64;
    const word = 1n << 32n;
    let inverse = 1n;
    const low = n % word;
    for (let round = 0; round < 6; round += 1) inverse = (inverse * (2n - low * inverse)) % word;
    const n0inv = (word - ((inverse + word) % word)) % word;
    const rr = (1n << 4096n) % n;
    const header = Buffer.alloc(8);
    header.writeUInt32LE(words, 0);
    header.writeUInt32LE(Number(n0inv), 4);
    const exponent = Buffer.alloc(4);
    exponent.writeUInt32LE(65537, 0);
    const raw = Buffer.concat([header, wordsOf(n, words), wordsOf(rr, words), exponent]);
    return Buffer.from(`${raw.toString("base64")} ${comment}\0`);
}

export function signToken(key: string, token: Buffer): Buffer {
    return privateEncrypt(
        { key, padding: constants.RSA_PKCS1_PADDING },
        Buffer.concat([SHA1_PREFIX, token])
    );
}

/** A path to the TV's adbd that carries whole packets. */
export interface AdbLink {
    /** One packet: USB sends its header and payload as two transfers, TCP as one write. */
    send(header: Buffer, data: Buffer): void;
    close(): void;
}

export interface AdbLinkEvents {
    data(chunk: Buffer): void;
    /** The link is gone - unplugged, closed by the TV, or failed. */
    lost(error: Error): void;
}

export type AdbLinkOpener = (events: AdbLinkEvents) => Promise<AdbLink>;

/** The network link: a TCP socket to the TV's port. */
export function tcpLink(host: string, port: number, connectMs: number): AdbLinkOpener {
    return (events) =>
        new Promise((resolve, reject) => {
            const socket: Socket = tcp({ host, port });
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error("timeout"));
            }, connectMs);
            socket.once("connect", () => {
                clearTimeout(timer);
                socket.removeAllListeners("error");
                socket.on("error", (error) => events.lost(error));
                socket.on("close", () => events.lost(new Error("The TV closed the connection.")));
                socket.on("data", (chunk) => events.data(chunk));
                resolve({
                    send: (header, data) => socket.write(Buffer.concat([header, data])),
                    close: () => socket.destroy()
                });
            });
            socket.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
        });
}

export interface AdbOptions {
    /** How to reach the TV; a TCP connection to `host`:`port` when absent. */
    readonly link?: AdbLinkOpener;
    readonly host?: string;
    readonly port?: number;
    /** PEM. Its public half is what the TV is asked to allow. */
    readonly key: string;
    readonly connectMs: number;
    /** How long somebody has to answer the prompt on the TV. */
    readonly approveMs: number;
    readonly commandMs: number;
    /** Called when the TV is showing its "Allow debugging?" prompt. */
    readonly onPrompt?: () => void;
}

interface Waiter {
    readonly match: (packet: Packet) => boolean;
    readonly resolve: (packet: Packet) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
}

export class AdbConnection {
    private link: AdbLink | null = null;
    private readonly reader = new PacketReader();
    private readonly inbox: Packet[] = [];
    private waiters: Waiter[] = [];
    private failure: Error | null = null;
    private nextId = 1;
    private maxPayload = MAX_PAYLOAD;

    constructor(private readonly options: AdbOptions) {}

    private fail(error: Error): void {
        this.failure ??= error;
        for (const waiter of this.waiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.reject(this.failure);
        }
    }

    private deliver(packet: Packet): void {
        const index = this.waiters.findIndex((waiter) => waiter.match(packet));
        if (index === -1) {
            this.inbox.push(packet);
            return;
        }
        const [waiter] = this.waiters.splice(index, 1);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        waiter.resolve(packet);
    }

    private next(match: (packet: Packet) => boolean, timeoutMs: number): Promise<Packet> {
        const queued = this.inbox.findIndex(match);
        if (queued !== -1) return Promise.resolve(this.inbox.splice(queued, 1)[0] as Packet);
        if (this.failure) return Promise.reject(this.failure);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
                reject(new Error("The TV stopped answering."));
            }, timeoutMs);
            this.waiters.push({ match, resolve, reject, timer });
        });
    }

    private send(command: number, arg0: number, arg1: number, data?: Buffer): void {
        const packet = encodePacket(command, arg0, arg1, data);
        this.link?.send(packet.subarray(0, HEADER_BYTES), packet.subarray(HEADER_BYTES));
    }

    async open(): Promise<void> {
        const { host = "", port = 0, connectMs } = this.options;
        const opener = this.options.link ?? tcpLink(host, port, connectMs);
        this.link = await opener({
            data: (chunk) => {
                try {
                    for (const packet of this.reader.push(chunk)) this.deliver(packet);
                } catch (caught) {
                    this.fail(caught as Error);
                    this.close();
                }
            },
            lost: (error) => this.fail(error)
        });
        this.send(A_CNXN, VERSION, MAX_PAYLOAD, Buffer.from("host::\0"));
        const isHandshake = (packet: Packet) => packet.command === A_CNXN || packet.command === A_AUTH;
        let answer = await this.next(isHandshake, connectMs);
        if (answer.command === A_AUTH && answer.arg0 === AUTH_TOKEN) {
            this.send(A_AUTH, AUTH_SIGNATURE, 0, signToken(this.options.key, answer.data));
            answer = await this.next(isHandshake, connectMs);
        }
        if (answer.command === A_AUTH) {
            this.send(A_AUTH, AUTH_PUBLIC_KEY, 0, androidPublicKey(this.options.key));
            this.options.onPrompt?.();
            answer = await this.next((packet) => packet.command === A_CNXN, this.options.approveMs);
        }
        this.maxPayload = Math.min(Math.max(answer.arg1, 1024), MAX_PAYLOAD);
    }

    private async stream(service: string): Promise<{ local: number; remote: number; }> {
        const local = this.nextId;
        this.nextId += 1;
        this.send(A_OPEN, local, 0, Buffer.from(`${service}\0`));
        const opened = await this.next(
            (packet) => packet.arg1 === local && (packet.command === A_OKAY || packet.command === A_CLSE),
            this.options.commandMs
        );
        if (opened.command === A_CLSE) throw new Error("The TV refused that.");
        return { local, remote: opened.arg0 };
    }

    /** One shell command's whole output. Run one at a time. */
    async shell(command: string, timeoutMs = this.options.commandMs): Promise<string> {
        const { local, remote } = await this.stream(`shell:${command}`);
        const chunks: Buffer[] = [];
        let size = 0;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const packet = await this.next(
                (one) => one.arg1 === local && (one.command === A_WRTE || one.command === A_CLSE),
                Math.max(1, deadline - Date.now())
            );
            if (packet.command === A_CLSE) break;
            this.send(A_OKAY, local, remote);
            size += packet.data.length;
            if (size <= MAX_OUTPUT) chunks.push(packet.data);
        }
        this.send(A_CLSE, local, remote);
        return Buffer.concat(chunks).toString("utf8");
    }

    private async write(local: number, remote: number, data: Buffer): Promise<void> {
        for (let at = 0; at < data.length; at += this.maxPayload) {
            this.send(A_WRTE, local, remote, data.subarray(at, at + this.maxPayload));
            await this.next(
                (packet) => packet.arg1 === local && packet.command === A_OKAY,
                this.options.commandMs
            );
        }
    }

    /** Pushes `data` to `path` through the sync service. */
    async push(path: string, data: Buffer, mode = 0o644): Promise<void> {
        const { local, remote } = await this.stream("sync:");
        const tagged = (tag: string, value: number, body?: Buffer): Buffer => {
            const head = Buffer.alloc(8);
            head.write(tag, 0, "ascii");
            head.writeUInt32LE(value, 4);
            return body ? Buffer.concat([head, body]) : head;
        };
        const target = Buffer.from(`${path},${mode}`);
        await this.write(local, remote, tagged("SEND", target.length, target));
        for (let at = 0; at < data.length; at += SYNC_CHUNK) {
            const chunk = data.subarray(at, at + SYNC_CHUNK);
            await this.write(local, remote, tagged("DATA", chunk.length, chunk));
        }
        await this.write(local, remote, tagged("DONE", Math.floor(Date.now() / 1000)));
        const answer = await this.next(
            (packet) => packet.arg1 === local && packet.command === A_WRTE,
            this.options.commandMs
        );
        this.send(A_OKAY, local, remote);
        this.send(A_CLSE, local, remote);
        if (answer.data.subarray(0, 4).toString("ascii") !== "OKAY") {
            throw new Error("The TV refused the file.");
        }
    }

    close(): void {
        const link = this.link;
        this.link = null;
        link?.close();
        // Nothing can answer a closed connection: whatever waits on it ends now, not at its timeout.
        this.fail(new Error("The connection was closed."));
    }
}
