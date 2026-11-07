/**
 * Encrypted DNS for devices: DNS over TLS (RFC 7858) on port 853, the protocol
 * Android's Private DNS speaks.
 *
 * A device in strict Private DNS mode checks the certificate against the name it
 * was given, so the server needs a publicly trusted certificate for a real
 * hostname. The only certificate whose key Polaris itself holds for a name of its
 * own is the wildcard for the deploy domain (`wildcard-cert-service.ts`): the
 * per-hostname certificates the edge orders over HTTP stay inside the edge's own
 * volume, which the dashboard does not mount. So the hostname is `dns.<deploy
 * domain>`, the certificate is that wildcard copied onto the engine's volume, and
 * the engine answers the hostname with its own address for the devices that ask it.
 *
 * Pure: the paths and the files are asserted in a test.
 */

import { createHash } from "node:crypto";
import { QUERY_LOG_DIR } from "./query-log";

/** The port DNS over TLS is served on (RFC 7858). */
export const DOT_PORT = 853;

/** The label the hostname takes under the deploy domain. */
const DOT_LABEL = "dns";

/** What the engine needs to serve DNS over TLS. */
export interface EngineTls {
    /** The name devices are given, and the certificate covers. */
    readonly hostname: string;
    /** The address the engine answers that name with: its own. */
    readonly address: string;
    readonly certFile: string;
    readonly keyFile: string;
}

/** A certificate and key Polaris holds for the deploy domain's wildcard. */
export interface DotCertificate {
    /** The deploy domain it covers `*.` of. */
    readonly base: string;
    readonly certPem: string;
    readonly keyPem: string;
}

/** The hostname devices set as their Private DNS under `base`. */
export function dotHostname(base: string): string {
    return `${DOT_LABEL}.${base.trim().toLowerCase()}`;
}

/** The paths on the engine's volume, named by the certificate itself: a renewed
 *  certificate is a new configuration, so the screen says it needs applying
 *  instead of the engine serving the old one until it next restarts. */
function dotPaths(certPem: string): { certFile: string; keyFile: string } {
    const id = createHash("sha256").update(certPem).digest("hex").slice(0, 16);
    return {
        certFile: `${QUERY_LOG_DIR}/dot-${id}.crt`,
        keyFile: `${QUERY_LOG_DIR}/dot-${id}.key`
    };
}

/** What the engine is configured with for `certificate`, answering at `address`. */
export function engineTlsFor(certificate: DotCertificate, address: string): EngineTls {
    return { hostname: dotHostname(certificate.base), address, ...dotPaths(certificate.certPem) };
}

/** The files written onto the engine's volume for `certificate`. */
export function dotFiles(certificate: DotCertificate): Map<string, string> {
    const paths = dotPaths(certificate.certPem);
    return new Map([
        [paths.certFile, certificate.certPem],
        [paths.keyFile, certificate.keyPem]
    ]);
}

/** The certificate and key files an encoded configuration names, or null when it
 *  serves no encrypted DNS or cannot be read. */
export function servedTlsFiles(
    encoded: string | null | undefined
): { certFile: string; keyFile: string } | null {
    if (!encoded) return null;
    try {
        const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const { certFile, keyFile } = parsed as Record<string, unknown>;
        return typeof certFile === "string" && typeof keyFile === "string"
            ? { certFile, keyFile }
            : null;
    } catch {
        return null;
    }
}

/** The command, as arguments and never a shell line, that removes every
 *  certificate and key file on the engine's volume but the ones in `keep`. */
export function staleDotFilesCommand(keep: Iterable<string>): string[] {
    const kept = [...new Set(keep)]
        .filter((path) => path.startsWith(`${QUERY_LOG_DIR}/dot-`))
        .sort()
        .flatMap((path) => ["!", "-path", path]);
    return [
        "find",
        QUERY_LOG_DIR,
        "-maxdepth",
        "1",
        "-type",
        "f",
        "-name",
        "dot-*",
        ...kept,
        "-exec",
        "rm",
        "-f",
        "{}",
        ";"
    ];
}
