import { connect } from "node:tls";

/**
 * How long a TLS handshake takes, or null when none completes. For the relay,
 * where the server's own edge accepts a connection whether or not the tunnel
 * behind it is up: only a handshake with the name proves the way home works.
 * Nothing is sent over it, so the certificate is not what is being asked.
 */
export function tlsTime(
    host: string,
    port: number,
    servername: string,
    timeoutMs: number
): Promise<number | null> {
    return new Promise((resolve) => {
        const started = performance.now();
        const socket = connect({ host, port, servername, rejectUnauthorized: false });
        const done = (value: number | null) => {
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(timeoutMs, () => done(null));
        socket.once("secureConnect", () => done(Math.round(performance.now() - started)));
        socket.once("error", () => done(null));
        socket.once("close", () => done(null));
    });
}
