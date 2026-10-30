import { connect } from "node:tls";

export interface Handshake {
    readonly ms: number;
    /** The SHA-256 fingerprint of the certificate that answered. */
    readonly certificate: string | null;
}

/**
 * A TLS handshake, timed, or null when none completes. For the relay, where the
 * server's own edge accepts a connection whether or not the tunnel behind it is up.
 * Nothing is sent over it and a house may not hold a valid certificate yet, so the
 * certificate is not verified: it is only reported, for the caller to compare.
 */
export function tlsHandshake(
    host: string,
    port: number,
    servername: string,
    timeoutMs: number
): Promise<Handshake | null> {
    return new Promise((resolve) => {
        const started = performance.now();
        const socket = connect({ host, port, servername, rejectUnauthorized: false });
        const done = (value: Handshake | null) => {
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(timeoutMs, () => done(null));
        socket.once("secureConnect", () =>
            done({
                ms: Math.round(performance.now() - started),
                certificate: socket.getPeerCertificate().fingerprint256 ?? null
            })
        );
        socket.once("error", () => done(null));
        socket.once("close", () => done(null));
    });
}
