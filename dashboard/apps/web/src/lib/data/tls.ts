/**
 * How a database connection is encrypted, and what its certificate is checked
 * against.
 *
 * The four modes are libpq's `sslmode`, which pgAdmin, DBeaver and every other
 * client name the same way, so somebody who has set one before recognises them:
 *
 * - `disable`: plain TCP.
 * - `require`: encrypted, nothing checked. Anybody between Polaris and the
 *   database can answer in its place, so the form says so when it is picked.
 * - `verify-ca`: the certificate must be signed by the authority given - one
 *   uploaded, or the server's own certificate trusted the first time (the TLS
 *   counterpart of the SSH host key below it) - or by a public one when none is.
 * - `verify-full`: the same, and the certificate must also be for the name the
 *   connection was saved with.
 *
 * Every driver is handed the options this builds and nothing else, so the four
 * engines cannot drift into four different ideas of what "verified" means.
 *
 * Server-only.
 */

import * as tls from "node:tls";
import type { TlsMode } from "./connection-schema";

export type { TlsMode } from "./connection-schema";

/** Everything a driver needs for the encrypted half of a connection. */
export interface DataTls {
    readonly mode: TlsMode;
    /** PEM: the authority to trust, when it is not a public one. */
    readonly ca: string | null;
    /** PEM: a client certificate and its key, for a server that asks for one. */
    readonly clientCert: string | null;
    readonly clientKey: string | null;
    /** The name the certificate must be for. The driver may be dialling an
     *  address (resolved here, or a tunnel's loopback port) instead. */
    readonly name: string | null;
}

/** No encryption. */
export const NO_TLS: DataTls = { mode: "disable", ca: null, clientCert: null, clientKey: null, name: null };

/** The mode a row saved before modes existed is read as: its switch said
 *  "encrypted, not verified", which is `require`. */
export function legacyTlsMode(tlsOn: boolean, mode: string | null | undefined): TlsMode {
    if (mode === "disable" || mode === "require" || mode === "verify-ca" || mode === "verify-full") {
        return mode;
    }
    return tlsOn ? "require" : "disable";
}

/**
 * The options for `tls.connect` - or null for a plain connection. The SNI name
 * is only set when it is a name: an address in SNI is refused by RFC 6066.
 */
export function tlsConnectOptions(settings: DataTls | null | undefined): tls.ConnectionOptions | null {
    if (!settings || settings.mode === "disable") return null;
    const options: tls.ConnectionOptions = {};
    if (settings.name && !isAddress(settings.name)) options.servername = settings.name;
    if (settings.clientCert && settings.clientKey) {
        options.cert = settings.clientCert;
        options.key = settings.clientKey;
    }
    if (settings.mode === "require") {
        options.rejectUnauthorized = false;
        return options;
    }
    options.rejectUnauthorized = true;
    if (settings.ca) options.ca = settings.ca;
    const name = settings.name;
    options.checkServerIdentity =
        settings.mode === "verify-ca" || !name
            ? () => undefined
            : (_host, cert) => tls.checkServerIdentity(name, cert);
    return options;
}

function isAddress(name: string): boolean {
    return /^[\d.]+$/.test(name) || name.includes(":");
}

/** The TLS failures a reader can act on, said in their words. */
export const TLS_REFUSALS = {
    untrusted:
        "The database's certificate is not signed by an authority this connection trusts, so nothing was sent to it. If its certificate was replaced, check it in the connection's settings.",
    expired: "The database's certificate has expired or is not valid yet, so nothing was sent to it.",
    wrongName: (name: string) =>
        `The database's certificate is not for ${name}, so nothing was sent to it.`,
    noTls:
        "This database server does not accept encrypted connections. Turn encryption off for it, or turn TLS on at the server."
} as const;

const UNTRUSTED = new Set([
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_UNTRUSTED",
    "CERT_SIGNATURE_FAILURE",
    "CERT_REJECTED",
    "INVALID_CA"
]);
const EXPIRED = new Set(["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"]);

/**
 * The sentence for a TLS failure somewhere in `error` - a driver often wraps
 * the socket's error in its own - or null when it was something else.
 */
export function tlsRefusal(error: unknown, name: string | null): string | null {
    for (const link of causes(error)) {
        const code = typeof link.code === "string" ? link.code : "";
        const message = typeof link.message === "string" ? link.message : "";
        if (UNTRUSTED.has(code)) return TLS_REFUSALS.untrusted;
        if (EXPIRED.has(code)) return TLS_REFUSALS.expired;
        if (code === "ERR_TLS_CERT_ALTNAME_INVALID" || /Hostname\/IP does not match/i.test(message)) {
            return TLS_REFUSALS.wrongName(name ?? "this server");
        }
        if (
            code === "HANDSHAKE_NO_SSL_SUPPORT" ||
            /does not support SSL|does not support secure connection|SSL is not enabled/i.test(message)
        ) {
            return TLS_REFUSALS.noTls;
        }
    }
    return null;
}

function* causes(error: unknown): Generator<{ code?: unknown; message?: unknown }> {
    let current: unknown = error;
    for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
        const link = current as { code?: unknown; message?: unknown; cause?: unknown; reason?: unknown };
        yield link;
        current = link.cause ?? link.reason;
    }
}
