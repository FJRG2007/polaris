/**
 * HTTP to a device, a bridge or a hub somebody pointed Polaris at.
 *
 * Deliberately not the dashboard's guarded fetch, for the reason `onvif.ts`
 * gives: that one exists to refuse private addresses, and a plug, a bridge and a
 * hub are private addresses - a guard that blocked 192.168.x would block every
 * one of them. What stands in for it is who may ask: connecting a device account
 * is `home.manage`, an administrative grant, precisely because it is somewhere a
 * person chooses the address Polaris dials. The rest of the care is here:
 *
 * - Redirects are never followed. A device answers for itself; a redirect off it
 *   is not something to chase from inside somebody's network.
 * - What comes back is capped, and only named fields are ever read out of it by
 *   the callers, so an address that turns out to be something else cannot be
 *   used to read internal services through the dashboard.
 * - TLS is verified, always, and per request rather than by switching anything
 *   off for the process. A bridge whose certificate is signed by its maker's own
 *   authority is checked against that authority; a hub whose certificate is its
 *   own is pinned the first time it is paired and must present the same one
 *   every time after. Either way the check happens on the socket before a single
 *   byte of the request - a key or a token - is written to it.
 *
 * Built on node's own http and tls rather than fetch, because a pinned
 * certificate and a private authority are per-connection settings that fetch
 * cannot be handed without a second copy of undici.
 *
 * Server-only.
 */

import { DriverError } from "../drivers/contract";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect, type PeerCertificate, type TLSSocket } from "node:tls";

/** Long enough for a plug on a tired access point, short enough that a screen
 *  waiting on one is not left there. */
const TIMEOUT_MS = 8000;

/** Devices answer in kilobytes. A whole house's state from a hub is the largest
 *  thing read here, and even that is well under this. */
const MAX_BYTES = 4_000_000;

/**
 * How a device's certificate is trusted.
 *
 * `authority`: the certificate must chain to this CA, and its common name is
 * handed to `name` to accept or refuse - which is how a Hue bridge is checked
 * against the bridge id it is supposed to be. `pin`: the certificate must be
 * exactly this one, by its SHA-256 fingerprint; `pin: null` is the pairing call,
 * the one moment a hub's own certificate is taken on trust and recorded.
 */
export type LanTrust =
    | {
          readonly authority: string;
          readonly name: (commonName: string) => boolean;
      }
    | { readonly pin: string | null };

export interface LanRequest {
    readonly url: string;
    readonly method?: "GET" | "POST" | "PUT" | "PATCH";
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string | Buffer;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
    /** Required for https. There is no default, because "whatever the system
     *  trusts" is wrong for every device that brings its own certificate. The
     *  one exception is `system`, for an address that has a real certificate -
     *  a Home Assistant behind a proper domain. */
    readonly trust?: LanTrust | "system";
}

export interface LanResponse {
    readonly status: number;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    readonly body: Buffer;
    /** The certificate the device presented, as a SHA-256 fingerprint and its
     *  common name. Null over plain http. */
    readonly certificate: { readonly fingerprint: string; readonly commonName: string } | null;
}

/** The body as text. */
export function textOf(response: LanResponse): string {
    return response.body.toString("utf8");
}

/** The body as JSON, or null when it is not JSON at all. A device that answered
 *  with a login page is not a device that answered. */
export function jsonOf(response: LanResponse): unknown {
    try {
        return JSON.parse(textOf(response)) as unknown;
    } catch {
        return null;
    }
}

/** A fingerprint in one spelling: uppercase hex with no separators, whatever
 *  node or a person wrote it as. */
export function normalizeFingerprint(value: string): string {
    return value.replace(/[^0-9a-f]/gi, "").toUpperCase();
}

function refusal(error: NodeJS.ErrnoException): DriverError {
    if (error instanceof DriverError) return error;
    const code = error.code ?? "";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        return new DriverError("That address could not be found on this network.", "unreachable");
    }
    if (code === "ECONNREFUSED") {
        return new DriverError("Nothing answered on that address and port.", "unreachable");
    }
    if (code === "ETIMEDOUT" || code === "ABORT_ERR" || error.name === "AbortError") {
        return new DriverError("The device did not answer in time.", "unreachable");
    }
    if (code.startsWith("ERR_TLS") || code.includes("CERT") || code.includes("SELF_SIGNED")) {
        return new DriverError(
            "The device's certificate is not one Polaris can trust, so nothing was sent to it.",
            "refused"
        );
    }
    return new DriverError("The device could not be reached.", "unreachable");
}

/**
 * A TLS connection that has already been checked.
 *
 * Opened here, not by the https client, so that the check is finished before the
 * request exists: a socket handed to `createConnection` is already trusted, and
 * the headers carrying a key go to nothing else.
 */
function secureSocket(
    host: string,
    port: number,
    trust: LanTrust,
    timeoutMs: number
): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
        const authority = "authority" in trust ? trust : null;
        const socket = tlsConnect({
            host,
            port,
            // An address is not a name a certificate can carry. What identifies
            // the device is checked below, by the rule its maker documents.
            servername: undefined,
            ...(authority
                ? {
                      ca: authority.authority,
                      rejectUnauthorized: true,
                      checkServerIdentity: (_host: string, certificate: PeerCertificate) =>
                          authority.name(String(certificate.subject?.CN ?? ""))
                              ? undefined
                              : new DriverError(
                                    "The device at that address is not the one Polaris was connected to. Connect it again.",
                                    "unauthorized"
                                )
                  }
                : {
                      // The chain of a hub's own certificate means nothing: it
                      // signed it itself. What is checked is that it is the
                      // same certificate, below, before anything is sent.
                      rejectUnauthorized: false
                  })
        });
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new DriverError("The device did not answer in time.", "unreachable"));
        }, timeoutMs);
        socket.once("secureConnect", () => {
            clearTimeout(timer);
            if ("pin" in trust && trust.pin !== null) {
                const presented = normalizeFingerprint(socket.getPeerCertificate().fingerprint256 ?? "");
                if (presented !== normalizeFingerprint(trust.pin)) {
                    socket.destroy();
                    reject(
                        new DriverError(
                            "The device at that address is not the one Polaris was connected to. Connect it again.",
                            "unauthorized"
                        )
                    );
                    return;
                }
            }
            resolve(socket);
        });
        socket.once("error", (error: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            socket.destroy();
            reject(refusal(error));
        });
    });
}

/** One request, answered or refused in a sentence. Never follows a redirect. */
export async function lanRequest(options: LanRequest): Promise<LanResponse> {
    const url = new URL(options.url);
    const secure = url.protocol === "https:";
    if (!secure && url.protocol !== "http:") {
        throw new DriverError("The device could not be reached.", "unreachable");
    }
    if (secure && !options.trust) {
        throw new DriverError(
            "The device's certificate is not one Polaris can trust, so nothing was sent to it.",
            "refused"
        );
    }
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? MAX_BYTES;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port) || (secure ? 443 : 80);

    const trust = options.trust;
    const socket =
        secure && trust && trust !== "system"
            ? await secureSocket(host, port, trust, timeoutMs)
            : null;

    return new Promise<LanResponse>((resolve, reject) => {
        const body =
            options.body === undefined
                ? undefined
                : typeof options.body === "string"
                  ? Buffer.from(options.body, "utf8")
                  : options.body;
        const send = secure ? httpsRequest : httpRequest;
        const request = send(
            {
                host,
                port,
                path: `${url.pathname}${url.search}`,
                method: options.method ?? "GET",
                headers: {
                    ...(options.headers ?? {}),
                    ...(body ? { "content-length": String(body.length) } : {})
                },
                // No agent: with one, node opens its own connection and the checked
                // socket would never be used.
                ...(socket ? { createConnection: () => socket } : {}),
                timeout: timeoutMs
            },
            (response) => {
                const chunks: Buffer[] = [];
                let size = 0;
                response.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > maxBytes) {
                        request.destroy();
                        reject(
                            new DriverError(
                                "The device answered with far more than Polaris reads from one.",
                                "refused"
                            )
                        );
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on("end", () => {
                    const tls = response.socket as TLSSocket;
                    const peer = secure && typeof tls.getPeerCertificate === "function" ? tls.getPeerCertificate() : null;
                    resolve({
                        status: response.statusCode ?? 0,
                        headers: response.headers,
                        body: Buffer.concat(chunks),
                        certificate: peer
                            ? {
                                  fingerprint: normalizeFingerprint(peer.fingerprint256 ?? ""),
                                  commonName: String(peer.subject?.CN ?? "")
                              }
                            : null
                    });
                });
                response.on("error", (error: NodeJS.ErrnoException) => reject(refusal(error)));
            }
        );
        request.on("timeout", () => {
            request.destroy();
            reject(new DriverError("The device did not answer in time.", "unreachable"));
        });
        request.on("error", (error: NodeJS.ErrnoException) => reject(refusal(error)));
        if (body) request.write(body);
        request.end();
    });
}

/**
 * Where a device is, from what somebody typed: an address, a name, or either
 * with a scheme and a port. Anything with a path, a query or credentials in it
 * is refused rather than trimmed into something else.
 *
 * `port` is the device's own default, used only when nothing was typed but an
 * address: somebody who wrote a scheme wrote the whole origin, and
 * `https://ha.example.test` means 443, not the default of a LAN install.
 */
export function deviceOrigin(typed: string, scheme: "http" | "https", port?: number): string | null {
    const raw = typed.trim();
    if (!raw) return null;
    const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    let url: URL;
    try {
        url = new URL(hadScheme ? raw : `${scheme}://${raw}`);
    } catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    if (!url.hostname) return null;
    const chosenPort = url.port || (!hadScheme && port !== undefined ? String(port) : "");
    return `${url.protocol}//${url.host.replace(/:\d+$/, "")}${chosenPort ? `:${chosenPort}` : ""}`;
}

/** Just the host of what somebody typed, for a device whose scheme and port are
 *  its maker's rather than a choice - a Hue bridge, a DIRIGERA hub. */
export function deviceHost(typed: string): string | null {
    const origin = deviceOrigin(typed, "https");
    return origin ? new URL(origin).hostname : null;
}
