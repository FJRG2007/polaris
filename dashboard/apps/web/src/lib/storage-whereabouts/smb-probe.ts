/**
 * Ask an SMB server who it is without telling it who we are.
 *
 * Two messages, both sent before any sign-in and neither carrying a credential:
 *
 * 1. NEGOTIATE. The answer carries the server's GUID - a 128-bit value the server
 *    generates to identify itself to clients (MS-SMB2 2.2.4).
 * 2. SESSION_SETUP with an NTLM NEGOTIATE token (MS-NLMP 2.2.1.1). The server
 *    answers with its CHALLENGE, whose target information lists its NetBIOS and
 *    DNS computer names (MS-NLMP 2.2.2.1). The exchange stops there: the
 *    AUTHENTICATE message, the only one that would prove anything about a
 *    password, is never sent.
 *
 * This is what makes it safe to point at an address Polaris is not sure about:
 * whoever answers learns that somebody asked, and nothing else.
 *
 * Server-only (opens a socket).
 */

import { Socket } from "node:net";
import { randomBytes } from "node:crypto";
import type { DeviceIdentity } from "./identity";

/** What one probe found, or why it found nothing. */
export type SmbProbeResult =
    | { readonly ok: true; readonly identity: DeviceIdentity }
    | {
          readonly ok: false;
          /** `closed`: nothing listens on the port, or nothing answered at all -
           *  the same answer an empty address gives. `refused`: something
           *  answered and it was not an SMB2 server Polaris could read. */
          readonly reason: "closed" | "refused";
          readonly detail: string;
      };

const SMB2_MAGIC = Buffer.from([0xfe, 0x53, 0x4d, 0x42]);
const NTLMSSP = Buffer.from("NTLMSSP\0", "latin1");
const STATUS_SUCCESS = 0;
const STATUS_MORE_PROCESSING_REQUIRED = 0xc0000016;

/** SMB 2.0.2, 2.1, 3.0 and 3.0.2: every dialect that needs no negotiate
 *  contexts, which is all a server has to understand to answer once. */
const DIALECTS = [0x0202, 0x0210, 0x0300, 0x0302];

function header(command: number, messageId: number): Buffer {
    const out = Buffer.alloc(64);
    SMB2_MAGIC.copy(out, 0);
    out.writeUInt16LE(64, 4); // StructureSize
    out.writeUInt16LE(0, 6); // CreditCharge
    out.writeUInt32LE(0, 8); // Status
    out.writeUInt16LE(command, 12);
    out.writeUInt16LE(1, 14); // CreditRequest
    out.writeUInt32LE(0, 16); // Flags
    out.writeUInt32LE(0, 20); // NextCommand
    out.writeBigUInt64LE(BigInt(messageId), 24);
    // ProcessId, TreeId, SessionId and Signature stay zero.
    return out;
}

/** One message as it travels: a four-byte direct-TCP length, then the message. */
function frame(message: Buffer): Buffer {
    const out = Buffer.alloc(4 + message.length);
    out.writeUInt32BE(message.length & 0x00ffffff, 0);
    message.copy(out, 4);
    return out;
}

export function negotiateRequest(): Buffer {
    const body = Buffer.alloc(36 + DIALECTS.length * 2);
    body.writeUInt16LE(36, 0); // StructureSize
    body.writeUInt16LE(DIALECTS.length, 2);
    body.writeUInt16LE(1, 4); // SecurityMode: signing enabled
    body.writeUInt32LE(0, 8); // Capabilities
    randomBytes(16).copy(body, 12); // ClientGuid
    DIALECTS.forEach((dialect, index) => body.writeUInt16LE(dialect, 36 + index * 2));
    return frame(Buffer.concat([header(0x0000, 0), body]));
}

/** NTLM NEGOTIATE: Unicode, NTLM, extended session security, and the request
 *  for target information that makes the server name itself. No domain, no
 *  workstation, no version - nothing about this side. */
export function ntlmNegotiate(): Buffer {
    const token = Buffer.alloc(32);
    NTLMSSP.copy(token, 0);
    token.writeUInt32LE(1, 8);
    const flags =
        0x00000001 | // NEGOTIATE_UNICODE
        0x00000004 | // REQUEST_TARGET
        0x00000200 | // NEGOTIATE_NTLM
        0x00008000 | // ALWAYS_SIGN
        0x00080000 | // EXTENDED_SESSIONSECURITY
        0x00800000 | // NEGOTIATE_TARGET_INFO
        0x20000000 | // 128-bit
        0x80000000; // 56-bit
    token.writeUInt32LE(flags >>> 0, 12);
    // Domain and workstation fields: empty, pointing at the end of the message.
    token.writeUInt32LE(32, 20);
    token.writeUInt32LE(32, 28);
    return token;
}

/** A DER element, with the long length form when it is needed. */
function der(tag: number, content: Buffer): Buffer {
    const length = content.length;
    let size: Buffer;
    if (length < 0x80) size = Buffer.from([length]);
    else if (length < 0x100) size = Buffer.from([0x81, length]);
    else size = Buffer.from([0x82, length >> 8, length & 0xff]);
    return Buffer.concat([Buffer.from([tag]), size, content]);
}

/** The NTLM token inside an SPNEGO NegTokenInit, which is what every SMB server
 *  expects in a first SESSION_SETUP (RFC 4178). */
export function spnegoInit(token: Buffer): Buffer {
    const spnegoOid = Buffer.from([0x06, 0x06, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x02]);
    const ntlmOid = Buffer.from([
        0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x02, 0x0a
    ]);
    const mechTypes = der(0xa0, der(0x30, ntlmOid));
    const mechToken = der(0xa2, der(0x04, token));
    const negTokenInit = der(0xa0, der(0x30, Buffer.concat([mechTypes, mechToken])));
    return der(0x60, Buffer.concat([spnegoOid, negTokenInit]));
}

export function sessionSetupRequest(): Buffer {
    const blob = spnegoInit(ntlmNegotiate());
    const body = Buffer.alloc(24);
    body.writeUInt16LE(25, 0); // StructureSize
    body.writeUInt8(0, 2); // Flags
    body.writeUInt8(1, 3); // SecurityMode: signing enabled
    body.writeUInt32LE(0, 4); // Capabilities
    body.writeUInt32LE(0, 8); // Channel
    body.writeUInt16LE(64 + 24, 12); // SecurityBufferOffset
    body.writeUInt16LE(blob.length, 14);
    return frame(Buffer.concat([header(0x0001, 1), body, blob]));
}

/** The GUID as 32 hex digits, in the order its bytes travel. */
export function readNegotiateResponse(message: Buffer): { serverGuid: string } {
    if (message.length < 64 + 24 || !message.subarray(0, 4).equals(SMB2_MAGIC)) {
        throw new Error("not an SMB2 answer");
    }
    const status = message.readUInt32LE(8);
    if (status !== STATUS_SUCCESS) {
        throw new Error(`the server refused to negotiate (0x${status.toString(16)})`);
    }
    return { serverGuid: message.subarray(64 + 8, 64 + 24).toString("hex") };
}

/** The names a CHALLENGE message carries in its target information. */
export function readChallenge(message: Buffer): Pick<DeviceIdentity, "netbiosName" | "dnsName"> {
    const at = message.indexOf(NTLMSSP);
    if (at < 0) throw new Error("no NTLM challenge in the answer");
    const challenge = message.subarray(at);
    if (challenge.length < 48 || challenge.readUInt32LE(8) !== 2) {
        throw new Error("the NTLM answer is not a challenge");
    }
    const infoLength = challenge.readUInt16LE(40);
    const infoOffset = challenge.readUInt32LE(44);
    if (infoOffset + infoLength > challenge.length) throw new Error("the NTLM challenge is cut short");
    const info = challenge.subarray(infoOffset, infoOffset + infoLength);

    const names: { netbiosName?: string; dnsName?: string } = {};
    let cursor = 0;
    while (cursor + 4 <= info.length) {
        const id = info.readUInt16LE(cursor);
        const length = info.readUInt16LE(cursor + 2);
        if (id === 0) break; // MsvAvEOL
        const value = info.subarray(cursor + 4, cursor + 4 + length);
        if (value.length !== length) break;
        if (id === 1) names.netbiosName = value.toString("utf16le");
        if (id === 3) names.dnsName = value.toString("utf16le");
        cursor += 4 + length;
    }
    return names;
}

/** Collects whole direct-TCP messages from a socket as they arrive. */
class Messages {
    private buffer = Buffer.alloc(0);
    private waiting: { resolve: (message: Buffer) => void; reject: (error: Error) => void } | null = null;
    private failure: Error | null = null;

    push(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.deliver();
    }

    fail(error: Error): void {
        this.failure ??= error;
        if (this.waiting) {
            this.waiting.reject(this.failure);
            this.waiting = null;
        }
    }

    next(): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            this.waiting = { resolve, reject };
            this.deliver();
            if (this.waiting && this.failure) this.fail(this.failure);
        });
    }

    private deliver(): void {
        if (!this.waiting || this.buffer.length < 4) return;
        const length = this.buffer.readUInt32BE(0) & 0x00ffffff;
        if (length > 1 << 20) {
            this.fail(new Error("the answer is too large to be an SMB greeting"));
            return;
        }
        if (this.buffer.length < 4 + length) return;
        const message = this.buffer.subarray(4, 4 + length);
        this.buffer = this.buffer.subarray(4 + length);
        const { resolve } = this.waiting;
        this.waiting = null;
        resolve(message);
    }
}

export interface ProbeOptions {
    readonly port?: number;
    /** How long the TCP connect may take. Short: on a LAN a host that is there
     *  answers in milliseconds, and a sweep pays this for every empty address. */
    readonly connectTimeoutMs?: number;
    /** How long the whole exchange may take once connected. */
    readonly timeoutMs?: number;
}

/**
 * Ask whoever is at `address` for its SMB identity.
 *
 * Never throws: an address with nothing on it is the common answer during a
 * sweep, and it is an answer, not an error.
 */
export function probeSmbIdentity(address: string, options: ProbeOptions = {}): Promise<SmbProbeResult> {
    const port = options.port ?? 445;
    const connectTimeoutMs = options.connectTimeoutMs ?? 1_500;
    const timeoutMs = options.timeoutMs ?? 5_000;

    return new Promise<SmbProbeResult>((resolve) => {
        const socket = new Socket();
        const messages = new Messages();
        let connected = false;
        let settled = false;

        const finish = (result: SmbProbeResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(result);
        };

        const timer = setTimeout(() => {
            const detail = connected ? "it stopped answering" : "nothing answered";
            messages.fail(new Error(detail));
            finish({ ok: false, reason: connected ? "refused" : "closed", detail });
        }, connectTimeoutMs);
        if (typeof timer.unref === "function") timer.unref();

        socket.on("data", (chunk: Buffer) => messages.push(chunk));
        socket.on("error", (error: NodeJS.ErrnoException) => {
            messages.fail(error);
            if (!connected) finish({ ok: false, reason: "closed", detail: error.code ?? error.message });
        });
        socket.on("close", () => messages.fail(new Error("the connection closed")));

        socket.connect(port, address, () => {
            connected = true;
            clearTimeout(timer);
            const exchangeTimer = setTimeout(() => {
                messages.fail(new Error("it stopped answering"));
            }, timeoutMs);
            if (typeof exchangeTimer.unref === "function") exchangeTimer.unref();

            void (async () => {
                try {
                    socket.write(negotiateRequest());
                    const { serverGuid } = readNegotiateResponse(await messages.next());
                    socket.write(sessionSetupRequest());
                    const reply = await messages.next();
                    const status = reply.length >= 12 ? reply.readUInt32LE(8) : -1;
                    // The server goes on to wait for an AUTHENTICATE that never
                    // comes; anything but "more processing" means it said no.
                    const names =
                        status === STATUS_MORE_PROCESSING_REQUIRED ? readChallenge(reply) : {};
                    finish({ ok: true, identity: { serverGuid, ...names } });
                } catch (error) {
                    finish({
                        ok: false,
                        reason: "refused",
                        detail: error instanceof Error ? error.message : String(error)
                    });
                } finally {
                    clearTimeout(exchangeTimer);
                }
            })();
        });
    });
}
