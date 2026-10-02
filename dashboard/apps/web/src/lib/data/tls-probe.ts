/**
 * The certificate a database server presents, read without signing in.
 *
 * "Trust the server's certificate" is trust on first use, like the SSH host key
 * below it in the form: the certificate is read once when the connection is
 * saved, kept, and every later connection has to present one that chains to it.
 * Reading it means starting TLS the way each engine does:
 *
 * - PostgreSQL asks first, with an 8-byte SSLRequest, and the server answers `S`
 *   or `N` before any TLS happens.
 * - MySQL and MariaDB send their greeting in the clear, the client answers with
 *   an SSLRequest packet that carries the CLIENT_SSL flag, and TLS starts.
 * - MongoDB and Redis speak TLS from the first byte.
 *
 * Nothing here sends a credential: the connection is closed as soon as the
 * handshake is over.
 *
 * Server-only.
 */

import * as tls from "node:tls";
import type { DataEngine } from "./driver";
import { createHash, X509Certificate } from "node:crypto";
import { connect as tcpConnect, type Socket } from "node:net";

const PROBE_TIMEOUT_MS = 8000;

/** The certificate to trust, and what to show about it. */
export interface ServerCertificate {
    /** PEM of the top of the chain the server sent: its root, or the
     *  certificate itself when it signed its own. */
    readonly anchor: string;
    /** What the form shows, so the reader can compare it with the server's. */
    readonly summary: CertificateSummary;
}

export interface CertificateSummary {
    readonly subject: string;
    readonly issuer: string;
    /** SHA-256 of the certificate, colon-separated hex, as browsers show it. */
    readonly fingerprint: string;
    readonly validTo: string;
}

export class CertificateProbeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CertificateProbeError";
    }
}

export const PROBE_REFUSALS = {
    noTls:
        "This database server does not accept encrypted connections. Turn encryption off for it, or turn TLS on at the server.",
    unreachable: (where: string) => `Polaris could not reach ${where} to read its certificate.`,
    noRoot:
        "The server's certificate is signed by an authority it does not send, so there is nothing to trust on first use. Upload that authority's certificate instead."
} as const;

/** Where to dial, and the name the certificate is read for. */
export interface ProbeTarget {
    readonly host: string;
    readonly port: number;
    /** The name as the connection was saved, for SNI and for the message. */
    readonly name: string;
}

/** How the TCP socket is opened. Swapped in tests. */
export type Dial = (host: string, port: number) => Socket;

const realDial: Dial = (host, port) => tcpConnect({ host, port });

/** Read the certificate `target` presents for `engine`, and pick the one to trust. */
export async function probeServerCertificate(
    engine: DataEngine,
    target: ProbeTarget,
    dial: Dial = realDial
): Promise<ServerCertificate> {
    const peer = await handshake(engine, target, dial);
    const anchor = topOfChain(peer);
    if (!selfIssued(anchor)) throw new CertificateProbeError(PROBE_REFUSALS.noRoot);
    const anchorPem = toPem(anchor.raw);

    // Prove the pin works on this Node before keeping it: a second handshake
    // that verifies against nothing but the anchor.
    await handshake(engine, target, dial, anchorPem);
    return { anchor: anchorPem, summary: summarize(anchorPem) };
}

/** What a PEM certificate says about itself, for the form. */
export function summarize(pem: string): CertificateSummary {
    const certificate = new X509Certificate(pem);
    return {
        subject: certificate.subject.replace(/\n/g, ", "),
        issuer: certificate.issuer.replace(/\n/g, ", "),
        fingerprint: certificate.fingerprint256,
        validTo: new Date(certificate.validTo).toISOString()
    };
}

function topOfChain(peer: tls.DetailedPeerCertificate): tls.DetailedPeerCertificate {
    let current = peer;
    const seen = new Set<string>();
    while (current.issuerCertificate && !seen.has(current.fingerprint256)) {
        seen.add(current.fingerprint256);
        const issuer = current.issuerCertificate;
        if (!issuer || issuer.fingerprint256 === current.fingerprint256) break;
        current = issuer;
    }
    return current;
}

function selfIssued(certificate: tls.DetailedPeerCertificate): boolean {
    try {
        const parsed = new X509Certificate(certificate.raw);
        return parsed.checkIssued(parsed) && parsed.verify(parsed.publicKey);
    } catch {
        return false;
    }
}

function toPem(der: Buffer): string {
    const body = der.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
    return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

/** A short digest for log lines and tests. */
export function certificateDigest(pem: string): string {
    return createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
}

/**
 * Open the socket, run whatever the engine needs before TLS, and complete the
 * handshake. With `trust`, the handshake must verify against it; without, it
 * is read as presented.
 */
async function handshake(
    engine: DataEngine,
    target: ProbeTarget,
    dial: Dial,
    trust?: string
): Promise<tls.DetailedPeerCertificate> {
    const socket = dial(target.host, target.port);
    const timer = setTimeout(
        () => socket.destroy(new Error("probe timed out")),
        PROBE_TIMEOUT_MS
    );
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
        }).catch(() => {
            throw new CertificateProbeError(PROBE_REFUSALS.unreachable(`${target.name}:${target.port}`));
        });

        if (engine === "postgres") await postgresPreamble(socket);
        else if (engine === "mysql" || engine === "mariadb") await mysqlPreamble(socket);

        const secure = tls.connect({
            socket,
            ...(isName(target.name) ? { servername: target.name } : {}),
            rejectUnauthorized: Boolean(trust),
            ...(trust ? { ca: trust, checkServerIdentity: () => undefined } : {})
        });
        await new Promise<void>((resolve, reject) => {
            secure.once("secureConnect", resolve);
            secure.once("error", reject);
        });
        const peer = secure.getPeerCertificate(true);
        secure.destroy();
        if (!peer || !peer.raw) throw new CertificateProbeError(PROBE_REFUSALS.noRoot);
        return peer;
    } catch (error) {
        if (error instanceof CertificateProbeError) throw error;
        if (trust) throw new CertificateProbeError(PROBE_REFUSALS.noRoot);
        throw new CertificateProbeError(PROBE_REFUSALS.noTls);
    } finally {
        clearTimeout(timer);
        socket.destroy();
    }
}

function isName(name: string): boolean {
    return !/^[\d.]+$/.test(name) && !name.includes(":");
}

/** PostgreSQL's SSLRequest: length 8, then the code 80877103. */
async function postgresPreamble(socket: Socket): Promise<void> {
    socket.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]));
    const answer = await read(socket, 1);
    if (answer[0] !== 0x53) throw new CertificateProbeError(PROBE_REFUSALS.noTls);
}

const CLIENT_LONG_PASSWORD = 0x1;
const CLIENT_PROTOCOL_41 = 0x200;
const CLIENT_SSL = 0x800;
const CLIENT_SECURE_CONNECTION = 0x8000;

/**
 * MySQL's greeting, then the 32-byte SSLRequest: capability flags, the largest
 * packet, a character set and 23 bytes of zeros, as sequence number 1.
 */
async function mysqlPreamble(socket: Socket): Promise<void> {
    const header = await read(socket, 4);
    const length = header.readUIntLE(0, 3);
    if (length <= 0 || length > 1 << 16) throw new CertificateProbeError(PROBE_REFUSALS.noTls);
    const greeting = await read(socket, length);
    // An error packet (0xff) is the server refusing this address outright.
    if (greeting[0] !== 0x0a) throw new CertificateProbeError(PROBE_REFUSALS.noTls);
    const versionEnd = greeting.indexOf(0, 1);
    // version, NUL, connection id (4), auth data (8), filler (1), then flags.
    const flagsAt = versionEnd + 1 + 4 + 8 + 1;
    if (versionEnd < 0 || flagsAt + 2 > greeting.length) throw new CertificateProbeError(PROBE_REFUSALS.noTls);
    if ((greeting.readUInt16LE(flagsAt) & CLIENT_SSL) === 0) {
        throw new CertificateProbeError(PROBE_REFUSALS.noTls);
    }
    const body = Buffer.alloc(32);
    body.writeUInt32LE(
        CLIENT_LONG_PASSWORD | CLIENT_PROTOCOL_41 | CLIENT_SSL | CLIENT_SECURE_CONNECTION,
        0
    );
    body.writeUInt32LE(1 << 24, 4);
    body[8] = 33;
    const packet = Buffer.alloc(4);
    packet.writeUIntLE(32, 0, 3);
    packet[3] = 1;
    socket.write(Buffer.concat([packet, body]));
}

/** Exactly `count` bytes from the socket, leaving anything after them unread. */
function read(socket: Socket, count: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        let held = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
            held = Buffer.concat([held, chunk]);
            if (held.length < count) return;
            cleanup();
            const rest = held.subarray(count);
            if (rest.length > 0) socket.unshift(rest);
            resolve(held.subarray(0, count));
        };
        const onEnd = () => {
            cleanup();
            reject(new CertificateProbeError(PROBE_REFUSALS.noTls));
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const cleanup = () => {
            socket.off("data", onData);
            socket.off("end", onEnd);
            socket.off("error", onError);
            socket.pause();
        };
        socket.on("data", onData);
        socket.once("end", onEnd);
        socket.once("error", onError);
        socket.resume();
    });
}
