/**
 * The network side of a domain audit: what `collect.ts` asks, answered for real.
 *
 * Every probe is bounded on its own - a timeout on each connection or request,
 * a cap on every body read - and only ever talks to public addresses: a name
 * that resolves to a private one is not dialled, so a domain somebody points at
 * their LAN cannot turn an audit into a scan of it. DNS is asked of the public
 * resolvers (what the internet sees), DNSSEC of a validating DNS-over-HTTPS
 * resolver, and registration of the registry's own RDAP server, found through
 * IANA's bootstrap file.
 *
 * Server-only.
 */

import tls from "node:tls";
import net from "node:net";
import type * as F from "./facts";
import * as core from "@polaris/core";
import type { Probes } from "./collect";
import { publicResolver } from "@/lib/dns/public-resolver";
import { createPublicKey, randomBytes } from "node:crypto";
import { configuredRequest, follow, readCapped, resolveName } from "@/lib/safe-fetch";
import { RDAP_BOOTSTRAP_URL, mergeRegistration, parseRdapDomain, rdapBaseFor, relatedRdapLink } from "./rdap";

const TIMEOUT_MS = 5_000;
/** The most any one answer read here is allowed to be. */
const MAX_JSON_BYTES = 512 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_AXFR_BYTES = 64 * 1024;

/** A validating resolver that answers DNSSEC questions as JSON. */
const DOH_JSON = "https://cloudflare-dns.com/dns-query";

/** The public addresses a name has, or [] - never a private one. */
async function publicAddresses(hostname: string): Promise<string[]> {
    try {
        const found = await resolveName(hostname);
        if (found.length === 0 || found.some((entry) => core.isPrivateIp(entry.address))) return [];
        return found.map((entry) => entry.address);
    } catch {
        return [];
    }
}

/** A body read as text, stopping at `max` bytes. */
async function textOf(response: Response, max: number): Promise<string | null> {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        size += value.length;
        if (size > max) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

async function dnssec(name: string, type: "DS" | "DNSKEY"): Promise<{ present: boolean; validated: boolean } | null> {
    const response = await fetch(`${DOH_JSON}?name=${encodeURIComponent(name)}&type=${type}&do=1`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store"
    });
    if (!response.ok) return null;
    const text = await textOf(response, MAX_TEXT_BYTES);
    if (!text) return null;
    const body = JSON.parse(text) as { Status?: number; AD?: boolean; Answer?: { type?: number }[] };
    // SERVFAIL from a validating resolver is what a broken chain looks like.
    if (body.Status === 2) return { present: true, validated: false };
    if (body.Status !== 0 && body.Status !== 3) return null;
    const code = type === "DS" ? 43 : 48;
    return { present: (body.Answer ?? []).some((entry) => entry.type === code), validated: body.AD === true };
}

/** An AXFR question for `domain`, in DNS's TCP framing (two length bytes first). */
export function axfrQuery(domain: string): Buffer {
    const labels = domain.replace(/\.$/, "").split(".").filter(Boolean);
    const question: number[] = [];
    for (const label of labels) {
        const bytes = Buffer.from(label, "ascii");
        question.push(bytes.length, ...bytes);
    }
    question.push(0, 0, 252, 0, 1);
    const message = Buffer.from([0x50, 0x4c, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...question]);
    const framed = Buffer.alloc(message.length + 2);
    framed.writeUInt16BE(message.length, 0);
    message.copy(framed, 2);
    return framed;
}

/** Whether the first message of a transfer answer hands over records: no error
 *  code and at least one answer. */
export function axfrGranted(framed: Buffer): boolean | null {
    if (framed.length < 14) return null;
    const length = framed.readUInt16BE(0);
    if (framed.length < 2 + Math.min(length, 12)) return null;
    const rcode = framed[5]! & 0x0f;
    const answers = framed.readUInt16BE(8);
    return rcode === 0 && answers > 0;
}

async function axfr(server: string, domain: string): Promise<boolean | null> {
    const [address] = await publicAddresses(server);
    if (!address) return null;
    return new Promise((resolve) => {
        const socket = net.connect({ host: address, port: 53, timeout: TIMEOUT_MS });
        let received = Buffer.alloc(0);
        let settled = false;
        const finish = (value: boolean | null) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(value);
        };
        socket.on("connect", () => socket.write(axfrQuery(domain)));
        socket.on("data", (chunk: Buffer) => {
            received = Buffer.concat([received, chunk]);
            if (received.length > MAX_AXFR_BYTES) return finish(axfrGranted(received));
            if (received.length >= 14) finish(axfrGranted(received));
        });
        // A server that closes the connection without answering has refused.
        socket.on("end", () => finish(received.length >= 14 ? axfrGranted(received) : false));
        socket.on("timeout", () => finish(null));
        socket.on("error", () => finish(null));
    });
}

// ---------------------------------------------------------------------------
// RDAP
// ---------------------------------------------------------------------------

let bootstrap: { at: number; value: unknown } | null = null;
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;

async function rdapJson(url: string): Promise<unknown | null> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    const response = await follow(parsed, "application/rdap+json, application/json");
    if (!response || response.status !== 200) return null;
    const bytes = await readCapped(response, MAX_JSON_BYTES);
    if (!bytes) return null;
    try {
        return JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
        return null;
    }
}

async function registration(domain: string): Promise<F.RegistrationFacts | null> {
    if (!bootstrap || Date.now() - bootstrap.at > BOOTSTRAP_TTL_MS) {
        const value = await rdapJson(RDAP_BOOTSTRAP_URL);
        if (value) bootstrap = { at: Date.now(), value };
    }
    const base = bootstrap ? rdapBaseFor(bootstrap.value, domain) : null;
    if (!base) return null;
    const answer = await rdapJson(`${base}domain/${encodeURIComponent(domain)}`);
    const registry = parseRdapDomain(answer);
    if (!registry) return null;
    // A thin registry (.com, .net) knows the dates; the registrar knows who holds it.
    const related = registry.registrantRedacted === null ? relatedRdapLink(answer) : null;
    const registrar = related ? parseRdapDomain(await rdapJson(related).catch(() => null)) : null;
    return mergeRegistration(registry, registrar);
}

// ---------------------------------------------------------------------------
// The web server
// ---------------------------------------------------------------------------

interface Handshake {
    readonly protocol: string | null;
    readonly certificate: F.CertificateFacts | null;
}

function handshake(host: string, address: string, legacy: boolean): Promise<Handshake | { error: string }> {
    return new Promise((resolve) => {
        const socket = tls.connect({
            host: address,
            port: 443,
            servername: host,
            timeout: TIMEOUT_MS,
            rejectUnauthorized: false,
            ...(legacy ? { minVersion: "TLSv1" as const, maxVersion: "TLSv1.1" as const, ciphers: "DEFAULT:@SECLEVEL=0" } : {})
        });
        let settled = false;
        const finish = (value: Handshake | { error: string }) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(value);
        };
        socket.on("secureConnect", () => {
            const peer = socket.getPeerCertificate();
            const issuer = peer?.issuer ? String(peer.issuer.O ?? peer.issuer.CN ?? "") : "";
            finish({
                protocol: socket.getProtocol(),
                certificate: peer?.valid_to
                    ? {
                          issuer,
                          validTo: new Date(peer.valid_to).toISOString(),
                          trusted: socket.authorized,
                          error: socket.authorizationError ? String(socket.authorizationError) : null
                      }
                    : null
            });
        });
        socket.on("timeout", () => finish({ error: "timed out" }));
        socket.on("error", (error: NodeJS.ErrnoException) => finish({ error: error.code ?? error.message }));
    });
}

/** The front page's answer, following up to three redirects that stay on HTTPS. */
async function frontPage(domain: string): Promise<Response | null> {
    let url = `https://${domain}/`;
    for (let hop = 0; hop < 4; hop += 1) {
        const response = await configuredRequest(url, { method: "GET", timeoutMs: TIMEOUT_MS }, { allowPrivate: false }).catch(() => null);
        if (!response) return null;
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
            await response.body?.cancel().catch(() => undefined);
            const next = new URL(location, url);
            if (next.protocol !== "https:") return null;
            url = next.href;
            continue;
        }
        return response;
    }
    return null;
}

async function httpRedirects(domain: string): Promise<boolean | null> {
    const response = await configuredRequest(`http://${domain}/`, { method: "GET", timeoutMs: TIMEOUT_MS }, { allowPrivate: false }).catch(() => null);
    if (!response) return null;
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location") ?? "";
    return response.status >= 300 && response.status < 400 && /^https:\/\//i.test(new URL(location, `http://${domain}/`).href);
}

async function securityTxt(domain: string): Promise<F.WebFacts["securityTxt"]> {
    const response = await configuredRequest(
        `https://${domain}/.well-known/security.txt`,
        { method: "GET", timeoutMs: TIMEOUT_MS },
        { allowPrivate: false }
    ).catch(() => null);
    if (!response) return null;
    const type = response.headers.get("content-type") ?? "";
    // A site that answers every path with its own page has no security.txt.
    if (response.status !== 200 || !/text\/plain/i.test(type)) {
        await response.body?.cancel().catch(() => undefined);
        return response.status === 200 || response.status === 404 || response.status === 410 ? { status: "missing" } : null;
    }
    const text = await textOf(response, MAX_TEXT_BYTES);
    return text === null ? null : { status: "ok", text };
}

async function web(domain: string, servedByPolaris: boolean): Promise<F.WebFacts | null> {
    const [address] = await publicAddresses(domain);
    if (!address) return null;
    const modern = await handshake(domain, address, false);
    if ("error" in modern) {
        return {
            certificate: null,
            httpsError: modern.error,
            protocol: null,
            legacyProtocol: undefined,
            httpRedirects: await httpRedirects(domain),
            headers: null,
            securityTxt: null,
            servedByPolaris
        };
    }
    const [legacy, redirects, page, security] = await Promise.all([
        handshake(domain, address, true),
        httpRedirects(domain),
        frontPage(domain),
        securityTxt(domain)
    ]);
    const headers: Record<string, string> = {};
    page?.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
    });
    await page?.body?.cancel().catch(() => undefined);
    // This build of TLS not offering 1.0 at all is not the server refusing it.
    const legacyProtocol = "error" in legacy ? (/NO_PROTOCOLS|UNSUPPORTED_PROTOCOL/i.test(legacy.error) ? undefined : null) : legacy.protocol;
    return {
        certificate: modern.certificate,
        httpsError: null,
        protocol: modern.protocol,
        legacyProtocol,
        httpRedirects: redirects,
        headers: page ? headers : null,
        securityTxt: security,
        servedByPolaris
    };
}

async function mtaStsPolicy(domain: string): Promise<F.MtaStsFetch> {
    // A policy is never fetched through a redirect (RFC 8461 3.3).
    const response = await configuredRequest(
        `https://mta-sts.${domain}/.well-known/mta-sts.txt`,
        { method: "GET", timeoutMs: TIMEOUT_MS },
        { allowPrivate: false }
    ).catch(() => null);
    if (!response) return { status: "unreachable" };
    if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return { status: "missing" };
    }
    const text = await textOf(response, MAX_TEXT_BYTES);
    return text === null ? { status: "missing" } : { status: "ok", text };
}

/** A DKIM key's size: an RSA key's modulus, 256 for Ed25519. */
export function keyBits(base64: string, keyType: string): number | null {
    if (keyType === "ed25519") return 256;
    const der = Buffer.from(base64, "base64");
    if (der.length === 0) return null;
    for (const type of ["spki", "pkcs1"] as const) {
        try {
            const key = createPublicKey({ key: der, format: "der", type });
            return key.asymmetricKeyDetails?.modulusLength ?? null;
        } catch {
            // Try the next encoding.
        }
    }
    return null;
}

/** The probes as they run for real. */
export function liveProbes(): Probes {
    return {
        dns: publicResolver(),
        dnssec,
        axfr,
        registration,
        web,
        mtaStsPolicy,
        keyBits,
        randomLabel: () => `polaris-${randomBytes(6).toString("hex")}`
    };
}
