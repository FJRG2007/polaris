/**
 * Domain configuration for Polaris's outward-facing URLs. Two domains are kept:
 * the app domain (the dashboard, stable) and the sharing domain (share links and
 * drop points - often a throwaway / free subdomain). Both fall back to
 * POLARIS_APP_URL when unset. DuckDNS is supported as a self-managed dynamic-DNS
 * option: its token is stored encrypted (like an integration secret) and the A
 * record can be synced to the current public IP on demand.
 *
 * Config lives in the Setting table (key/value, via setting-store), so no schema
 * change is needed.
 */

import { loadEnv } from "@polaris/config";
import { getSetting, setSetting } from "./setting-store";
import { getHostLanIp, isLanAddress } from "./host-address";
import { getPolarisPublicUrl } from "./polaris-tunnel-service";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { polarisZoneHost, zoneReachable } from "./domain-zones";
import { publicHostname, syncDashboardRoute } from "./domain-edge";
import { magicDomain, DEFAULT_SUBDOMAIN_BASE } from "@polaris/deploy";

const KEYS = {
    app: "domain.app",
    sharing: "domain.sharing",
    extra: "domain.extra",
    duckSub: "domain.duckdns.subdomain",
    duckToken: "domain.duckdns.token",
    deployBase: "domain.deploy.base",
    publicIp: "domain.publicIp",
    // Set only when the address came from a person rather than from detection, so
    // live detection can correct a stale detected one without overwriting a choice.
    publicIpManual: "domain.publicIp.manual"
} as const;

/** Non-secret domain config for the admin panel. */
export interface DomainConfig {
    appDomain: string;
    sharingDomain: string;
    /** Further hostnames the dashboard answers on, beyond those two. */
    extraDomains: string[];
    duckdnsSubdomain: string;
    hasDuckdnsToken: boolean;
    /** Wildcard-DNS base for free auto subdomains (sslip.io by default). */
    deployBase: string;
    /** Public IP used to build free subdomains, when no domain is configured. */
    publicIp: string;
}

/** Normalize a user-typed domain into an https base URL with no trailing slash. */
function normalizeUrl(value: string | null): string | null {
    if (!value || !value.trim()) return null;
    let url = value.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    return url;
}

/** How many extra hostnames one deployment may route, so the generated edge rule
 *  stays a rule and not a wall of `Host()` clauses. */
const EXTRA_DOMAIN_MAX = 32;

/**
 * The hostnames added on top of the app and sharing domain. Stored as a JSON list
 * in one setting rather than a row each: they are read together on every edge sync
 * and never addressed individually. A malformed value reads as none - the dashboard
 * still answers on its own domains, which is the safer half of the failure.
 */
export async function getExtraDomains(): Promise<string[]> {
    const raw = await getSetting(KEYS.extra);
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((value): value is string => typeof value === "string");
    } catch {
        return [];
    }
}

/**
 * Replace the extra hostnames. Each is normalized the way the edge reads it and
 * anything that is not a public name is dropped, so a typo cannot become a router
 * rule or an ACME order that retries until it is rate-limited. Returns what was
 * stored, which is what the caller should show.
 */
export async function setExtraDomains(input: readonly string[]): Promise<string[]> {
    const hosts: string[] = [];
    for (const entry of input) {
        const host = publicHostname(entry);
        if (host && !hosts.includes(host)) hosts.push(host);
        if (hosts.length >= EXTRA_DOMAIN_MAX) break;
    }
    await setSetting(KEYS.extra, hosts.length > 0 ? JSON.stringify(hosts) : null);
    await syncDashboardRoute();
    return hosts;
}

/**
 * Stop answering on a hostname, wherever it was configured. Settings lists the
 * addresses without knowing which setting each came from, so the lookup happens
 * here: a name can be the app domain, the sharing domain, an extra one, or several
 * at once. Returns true when something was actually cleared - a zone hostname is
 * owned by the guided setup and is not removable from a list.
 */
export async function removeDashboardDomain(value: string): Promise<boolean> {
    const host = publicHostname(value);
    if (!host) return false;
    const [app, sharing, extra] = await Promise.all([
        getSetting(KEYS.app),
        getSetting(KEYS.sharing),
        getExtraDomains()
    ]);
    let removed = false;
    if (publicHostname(app) === host) {
        await setSetting(KEYS.app, null);
        removed = true;
    }
    if (publicHostname(sharing) === host) {
        await setSetting(KEYS.sharing, null);
        removed = true;
    }
    if (extra.includes(host)) {
        await setSetting(KEYS.extra, extra.length > 1 ? JSON.stringify(extra.filter((entry) => entry !== host)) : null);
        removed = true;
    }
    if (removed) await syncDashboardRoute();
    return removed;
}

export async function getDomainConfig(): Promise<DomainConfig> {
    const [app, sharing, extra, sub, token, base, ip] = await Promise.all([
        getSetting(KEYS.app),
        getSetting(KEYS.sharing),
        getExtraDomains(),
        getSetting(KEYS.duckSub),
        getSetting(KEYS.duckToken),
        getSetting(KEYS.deployBase),
        getSetting(KEYS.publicIp)
    ]);
    return {
        appDomain: app ?? "",
        sharingDomain: sharing ?? "",
        extraDomains: extra,
        duckdnsSubdomain: sub ?? "",
        hasDuckdnsToken: Boolean(token),
        deployBase: base ?? DEFAULT_SUBDOMAIN_BASE,
        publicIp: ip ?? ""
    };
}

/** The wildcard-DNS base for free auto subdomains. */
export async function deployBase(): Promise<string> {
    return (await getSetting(KEYS.deployBase)) || DEFAULT_SUBDOMAIN_BASE;
}

/**
 * The public IP used to build free subdomains and to reach this server directly.
 *
 * Resolution order: an address the operator set themselves, then the one the mDNS
 * responder detects on the host right now, then the value detected once at install,
 * then the `POLARIS_PUBLIC_IP` env var - so free subdomains and the direct IP links
 * work out of the box without depending on request-time header detection (which
 * Docker's NAT can mask).
 *
 * Live detection sits above the stored value because the stored one is written once
 * and never revisited: it came from a request header, on whichever interface that
 * request arrived on, and a DHCP lease that moves or a wireless NIC that answered
 * that day leaves it naming an address the box no longer has. It only overrides a
 * stored address that is itself a LAN one - an operator who deliberately recorded
 * this server's WAN address keeps it, since the responder only ever reports a
 * private one and would otherwise quietly replace it.
 */
export async function getPublicIp(): Promise<string | null> {
    const [stored, manual] = await Promise.all([getSetting(KEYS.publicIp), getSetting(KEYS.publicIpManual)]);
    if (stored && manual === "1") return stored;
    if (!stored || isLanAddress(stored)) {
        const detected = await getHostLanIp();
        if (detected) return detected;
    }
    if (stored) return stored;
    const env = (process.env.POLARIS_PUBLIC_IP ?? "").trim().replace(/:\d+$/, "");
    return isRoutableIpv4(env) ? env : null;
}

/** A routable (non-loopback/unspecified) IPv4 literal. */
function isRoutableIpv4(value: string): boolean {
    const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return false;
    const octets = match.slice(1, 5).map(Number);
    if (octets.some((n) => n > 255)) return false;
    return octets[0] !== 127 && octets[0] !== 0;
}

/**
 * Auto-fill the free-subdomain public IP from a detected server address the first
 * time (Caddy sets `X-Server-Ip` to the connection's local host, e.g. 192.168.1.138,
 * even when reached by hostname), so free subdomains work with zero setup - the way
 * Dokploy/Coolify do. An address already recorded is never overwritten; a detected
 * one written here does not outrank what the responder sees on the host today, so a
 * value that goes stale is corrected by `getPublicIp` rather than left to rot.
 */
export async function ensurePublicIp(candidate: string | null | undefined): Promise<void> {
    if (!candidate) return;
    const ip = candidate.trim().replace(/:\d+$/, "");
    if (!isRoutableIpv4(ip)) return;
    if (await getPublicIp()) return;
    await setSetting(KEYS.publicIp, ip);
}

/** A free HTTPS subdomain for a named service pointing at the host, or null when
 *  no public IP is known (then callers fall back to a configured domain). */
export async function autoSubdomainUrl(name: string): Promise<string | null> {
    const ip = await getPublicIp();
    if (!ip) return null;
    return `https://${magicDomain(name, ip, await deployBase())}`;
}

/**
 * The best address Polaris is actually reachable at from outside the LAN, or null
 * when none is known. In order: the operator's own Polaris zone, a running Polaris
 * Cloudflare tunnel (the NAT fallback, since a DuckDNS/auto name does not resolve
 * to a reachable box behind NAT), a DuckDNS subdomain, then a free auto subdomain.
 *
 * `autoName` is the label the free subdomain is built from, so the app and the
 * sharing surface get distinguishable hostnames.
 */
async function reachableBaseUrl(autoName: string): Promise<string | null> {
    // A configured zone beats an ephemeral tunnel URL - but only once its DNS has been
    // seen resolving here. Saving the layout in the wizard is an intention; until the
    // records exist, a link on that hostname resolves nowhere, and the tunnel below
    // still works.
    if (await zoneReachable()) {
        const zone = await polarisZoneHost();
        if (zone) return `https://${zone}`;
    }

    const tunnel = normalizeUrl(await getPolarisPublicUrl());
    if (tunnel) return tunnel;

    const duckSub = await getSetting(KEYS.duckSub);
    if (duckSub) return `https://${duckSub}.duckdns.org`;

    return autoSubdomainUrl(autoName);
}

/**
 * Base URL for anything Polaris hands to a person or a machine that is not on this
 * LAN: an invite, a verification link, a notification link, an enrollment command.
 *
 * The configured app domain wins, then whatever Polaris is genuinely reachable at.
 * POLARIS_APP_URL is deliberately last: the installer sets it to `http://polaris.local`,
 * a name that only resolves over mDNS on this network, so preferring it would mint
 * links nobody outside the house can open.
 */
export async function appBaseUrl(): Promise<string> {
    const configured = normalizeUrl(await getSetting(KEYS.app));
    if (configured) return configured;
    return (await reachableBaseUrl("app")) ?? loadEnv().POLARIS_APP_URL;
}

/**
 * The app URL, but only when it is one the public internet can reach - otherwise
 * null. Anything handed to an outside service that will call back here needs this
 * rather than `appBaseUrl()`: on a LAN-only install that resolves to a name only
 * this network knows, and a provider that validates the address (GitHub refuses an
 * app manifest whose webhook is unreachable) rejects the whole registration.
 */
export async function publicAppUrl(): Promise<string | null> {
    const url = await appBaseUrl();
    return publicHostname(url) ? url.replace(/\/+$/, "") : null;
}

/**
 * The origin of a request, as an address a browser can be sent back to.
 *
 * Only one thing is corrected: `0.0.0.0` (and its IPv6 spelling) is the address the
 * server binds every interface on, not one anybody can navigate to - Chrome refuses
 * it outright - so it becomes the name for the machine that reached it. Everything
 * else is left as it is: the browser is loading the dashboard on it right now, which
 * is the only proof that exists that an address works.
 */
export function browserOrigin(requestOrigin: string): string {
    const url = new URL(requestOrigin);
    if (["0.0.0.0", "::", "[::]"].includes(url.hostname)) url.hostname = "localhost";
    return url.origin;
}

/**
 * Base URL for share links and drop points. Same chain as the app URL, except an
 * explicitly configured sharing domain wins and the app domain is consulted only
 * after the reachable addresses - sharing is where a throwaway or free hostname
 * belongs, while the dashboard's own domain is expected to be stable.
 */
export async function sharingBaseUrl(): Promise<string> {
    const configured = normalizeUrl(await getSetting(KEYS.sharing));
    if (configured) return configured;

    const reachable = await reachableBaseUrl("share");
    if (reachable) return reachable;

    return normalizeUrl(await getSetting(KEYS.app)) ?? loadEnv().POLARIS_APP_URL;
}

/** Save domain config. Each field is tri-state: a value sets it, "" clears it,
 *  undefined leaves it. The DuckDNS token is stored encrypted. */
export async function setDomainConfig(input: {
    appDomain?: string;
    sharingDomain?: string;
    duckdnsSubdomain?: string;
    duckdnsToken?: string;
    deployBase?: string;
    publicIp?: string;
}): Promise<void> {
    if (input.appDomain !== undefined) await setSetting(KEYS.app, input.appDomain.trim() || null);
    if (input.sharingDomain !== undefined) await setSetting(KEYS.sharing, input.sharingDomain.trim() || null);
    if (input.duckdnsSubdomain !== undefined) await setSetting(KEYS.duckSub, input.duckdnsSubdomain.trim() || null);
    if (input.deployBase !== undefined) await setSetting(KEYS.deployBase, input.deployBase.trim() || null);
    if (input.publicIp !== undefined) {
        const value = input.publicIp.trim() || null;
        await setSetting(KEYS.publicIp, value);
        // Typed in, so it outranks detection from here on. Cleared with the value, so
        // emptying the field hands the address back to detection rather than leaving
        // an empty manual override behind.
        await setSetting(KEYS.publicIpManual, value ? "1" : null);
    }
    // A saved domain is only a domain once the edge serves it, so republish the route
    // here rather than at each call site - the wizard, the admin panel and the DNS
    // check's dashboard move all land on this function.
    if (input.appDomain !== undefined || input.sharingDomain !== undefined) await syncDashboardRoute();
    if (input.duckdnsToken !== undefined && input.duckdnsToken.trim()) {
        const blob = encryptSecret(input.duckdnsToken.trim(), loadEnv().POLARIS_MASTER_KEY);
        await setSetting(
            KEYS.duckToken,
            JSON.stringify({
                c: blob.ciphertext.toString("base64"),
                n: blob.nonce.toString("base64"),
                k: blob.keyId
            })
        );
    }
}

/** Forget the stored DuckDNS token. */
export async function clearDuckdnsToken(): Promise<void> {
    await setSetting(KEYS.duckToken, null);
}

async function getDuckdnsToken(): Promise<string | null> {
    const raw = await getSetting(KEYS.duckToken);
    if (!raw) return null;
    try {
        const { c, n, k } = JSON.parse(raw) as { c: string; n: string; k: string };
        return decryptSecret(
            { ciphertext: Buffer.from(c, "base64"), nonce: Buffer.from(n, "base64"), keyId: k },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch {
        return null;
    }
}

/** Whether a DuckDNS subdomain + token are configured (for the UI + auto-sync). */
export async function duckdnsConfigured(): Promise<boolean> {
    const [sub, token] = await Promise.all([getSetting(KEYS.duckSub), getDuckdnsToken()]);
    return Boolean(sub && token);
}

let duckdnsStarted = false;

/**
 * Keep the DuckDNS A record pointed at the box's current public IP so a free
 * `<sub>.duckdns.org` domain (usable as a wildcard base, since DuckDNS resolves
 * `*.<sub>.duckdns.org` too) stays reachable as the ISP-assigned IP changes.
 * Idempotent; a no-op until a subdomain + token are configured.
 */
export function startDuckDnsSync(): void {
    if (duckdnsStarted) return;
    duckdnsStarted = true;
    const tick = (): void => void syncDuckDns().catch(() => undefined);
    setInterval(tick, 10 * 60 * 1000).unref?.();
    setTimeout(tick, 20_000).unref?.();
}

/** Update the DuckDNS record to the caller's current public IP. */
export async function syncDuckDns(): Promise<{ ok: boolean; detail: string }> {
    const sub = await getSetting(KEYS.duckSub);
    const token = await getDuckdnsToken();
    if (!sub || !token) return { ok: false, detail: "Set the DuckDNS subdomain and token first." };
    try {
        const res = await fetch(
            `https://www.duckdns.org/update?domains=${encodeURIComponent(sub)}&token=${encodeURIComponent(token)}&ip=`,
            { cache: "no-store" }
        );
        const text = (await res.text()).trim();
        return { ok: text.startsWith("OK"), detail: text || `HTTP ${res.status}` };
    } catch (caught) {
        return { ok: false, detail: caught instanceof Error ? caught.message : "DuckDNS request failed" };
    }
}
