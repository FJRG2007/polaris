/**
 * Network topology and exposure strategy. Detects whether Polaris runs on a box
 * with a directly reachable public IP (a data centre / VPS) or behind NAT (a home
 * / office server), and derives how auto-generated domains should be exposed so an
 * app never gets a subdomain that silently does not work off the LAN.
 *
 * The operator can override the detected mode and configure a wildcard domain they
 * point at their public IP. Config lives in the Setting table (no schema change).
 */

import { prisma } from "@polaris/db";
import { DEFAULT_SUBDOMAIN_BASE, magicDomain } from "@polaris/deploy";
import { deployBase, duckdnsConfigured, getPublicIp } from "./domain-service";

/**
 * - `auto`     : classify from detection (public IP -> public, else LAN-only).
 * - `lan`      : free subdomains embed the LAN IP; reachable only on the network.
 * - `public`   : the box's IP is internet-reachable; free subdomains get real TLS.
 * - `wildcard` : the operator points `*.<domain>` at their public IP; Polaris
 *                mints `<app>.<domain>` and gets a Let's Encrypt cert.
 * - `tunnel`   : public access is via a Cloudflare/ngrok tunnel per service; the
 *                auto domain stays LAN-only and the UI points at the tunnel.
 */
export type NetworkMode = "auto" | "lan" | "public" | "wildcard" | "tunnel";
export type EffectiveMode = Exclude<NetworkMode, "auto">;

const MODES: NetworkMode[] = ["auto", "lan", "public", "wildcard", "tunnel"];

const KEYS = {
    mode: "network.mode",
    wildcardDomain: "network.wildcardDomain",
    detectedIp: "network.detectedPublicIp",
    detectedAt: "network.detectedPublicIpAt",
    placement: "network.placement"
} as const;

/** Where Polaris is hosted, inferred from cloud signals. */
export type ServerPlacement = "cloud" | "home" | "unknown";

/**
 * Classify the host as a cloud/data-centre box or a home/office server. The
 * strongest signal is a cloud metadata service on the 169.254.169.254 link-local
 * address (AWS/GCP/Azure IMDS answer there and nothing else does); a public server
 * IP also implies cloud, a private one a home/NAT box. Cached - placement is
 * stable for the life of the machine.
 */
export async function detectPlacement(force = false): Promise<ServerPlacement> {
    if (!force) {
        const cached = await getSetting(KEYS.placement);
        if (cached === "cloud" || cached === "home" || cached === "unknown") return cached;
    }
    let placement: ServerPlacement = "unknown";
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        // Any HTTP response from the metadata IP (200 IMDSv1, 401 IMDSv2, 403/404
        // on other clouds) means a cloud VM; only cloud networks route this address.
        const res = await fetch("http://169.254.169.254/latest/meta-data/", {
            cache: "no-store",
            signal: controller.signal,
            headers: { "Metadata-Flavor": "Google" }
        });
        clearTimeout(timer);
        void res;
        placement = "cloud";
    } catch {
        // No metadata endpoint: fall back to the public-IP shape.
        const ip = await getPublicIp();
        if (ip) placement = isPrivateIpv4(ip) ? "home" : "cloud";
    }
    await setSetting(KEYS.placement, placement);
    return placement;
}

/** Re-detect the public IP if the cached value is older than this. */
const DETECT_TTL_MS = 6 * 60 * 60 * 1000;

async function getSetting(key: string): Promise<string | null> {
    const row = await prisma.setting.findUnique({ where: { key }, select: { value: true } });
    return row?.value ?? null;
}

async function setSetting(key: string, value: string | null): Promise<void> {
    if (value === null) {
        await prisma.setting.deleteMany({ where: { key } });
        return;
    }
    await prisma.setting.upsert({ where: { key }, create: { key, value, scope: "global" }, update: { value } });
}

/** An IPv4 literal that is not publicly routable (RFC1918, CGNAT, link-local, loopback). */
export function isPrivateIpv4(ip: string): boolean {
    const match = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return true;
    const [a, b] = match.slice(1, 3).map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
}

/** Fetch the box's external public IP from an echo service, cached with a TTL. */
export async function detectPublicIp(force = false): Promise<string | null> {
    if (!force) {
        const at = Number(await getSetting(KEYS.detectedAt));
        const cached = await getSetting(KEYS.detectedIp);
        if (cached && Number.isFinite(at) && Date.now() - at < DETECT_TTL_MS) return cached;
    }
    for (const url of ["https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"]) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 4000);
            const res = await fetch(url, { cache: "no-store", signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok) continue;
            const ip = (await res.text()).trim();
            if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
                await setSetting(KEYS.detectedIp, ip);
                await setSetting(KEYS.detectedAt, String(Date.now()));
                return ip;
            }
        } catch {
            // Try the next provider (offline, blocked, or a slow endpoint).
        }
    }
    return getSetting(KEYS.detectedIp);
}

export interface NetworkStatus {
    /** The stored mode (may be "auto"). */
    mode: NetworkMode;
    /** The resolved mode after auto-classification. */
    effectiveMode: EffectiveMode;
    /** The IP free subdomains embed today (the box's LAN IP on a home server). */
    subdomainIp: string | null;
    /** The box's external public IP, when detectable. */
    publicIp: string | null;
    /** True when the subdomain IP is private, so auto subdomains are LAN-only. */
    natted: boolean;
    /** True when the subdomain IP is itself internet-reachable. */
    autoSubdomainsPublic: boolean;
    /** The wildcard base domain the operator configured (empty if none). */
    wildcardDomain: string;
    /** The free-subdomain magic base (sslip.io by default). */
    subdomainBase: string;
    /** Whether the box looks like a cloud VM or a home/office server. */
    placement: ServerPlacement;
    /** Whether a DuckDNS subdomain + token are configured. */
    duckdns: boolean;
}

export async function getNetworkStatus(): Promise<NetworkStatus> {
    const [storedMode, wildcard, subdomainIp, publicIp, base, placement, duckdns] = await Promise.all([
        getSetting(KEYS.mode),
        getSetting(KEYS.wildcardDomain),
        getPublicIp(),
        detectPublicIp(),
        deployBase(),
        detectPlacement(),
        duckdnsConfigured()
    ]);
    const mode = MODES.includes(storedMode as NetworkMode) ? (storedMode as NetworkMode) : "auto";
    const autoSubdomainsPublic = Boolean(subdomainIp) && !isPrivateIpv4(subdomainIp!);
    const natted = !autoSubdomainsPublic || (Boolean(publicIp) && publicIp !== subdomainIp);
    const effectiveMode: EffectiveMode = mode === "auto" ? (autoSubdomainsPublic ? "public" : "lan") : mode;
    return {
        mode,
        effectiveMode,
        subdomainIp,
        publicIp,
        natted,
        autoSubdomainsPublic,
        wildcardDomain: wildcard ?? "",
        subdomainBase: base,
        placement,
        duckdns
    };
}

export async function setNetworkConfig(input: { mode?: NetworkMode; wildcardDomain?: string }): Promise<void> {
    if (input.mode !== undefined && MODES.includes(input.mode)) await setSetting(KEYS.mode, input.mode);
    if (input.wildcardDomain !== undefined) {
        const clean = input.wildcardDomain
            .trim()
            .replace(/^https?:\/\//, "")
            .replace(/^\*\./, "")
            .replace(/\/+$/, "");
        await setSetting(KEYS.wildcardDomain, clean || null);
    }
}

/** How a new auto domain should be exposed, decided from the topology and mode. */
export interface AutoDomainPlan {
    hostname: string;
    cert: "internal" | "le" | "none";
    /** "lan" marks a subdomain that only resolves on the local network. */
    kind: "auto" | "lan";
}

/**
 * Resolve the hostname + cert for a service's free auto domain from the network
 * mode, so it is honest about reachability: a wildcard/public setup mints a real,
 * internet-reachable name with Let's Encrypt; otherwise a LAN-only sslip.io name
 * served by the internal CA, flagged so the UI can say so instead of pretending it
 * works everywhere. Null when no IP or domain is known at all.
 */
export async function resolveAutoDomain(name: string, override?: { ip: string }): Promise<AutoDomainPlan | null> {
    // An app on a remote server gets a subdomain that embeds THAT server's IP and
    // is served by its own edge, so it never inherits the Polaris host's IP or
    // network mode: a public IP earns a real Let's Encrypt name, a private one a
    // LAN-only internal name. The wildcard/mode logic below is for the local host.
    if (override) {
        const ip = override.ip.trim();
        if (!ip) return null;
        const publicIp = !isPrivateIpv4(ip);
        return {
            hostname: magicDomain(name, ip, DEFAULT_SUBDOMAIN_BASE),
            cert: publicIp ? "le" : "internal",
            kind: publicIp ? "auto" : "lan"
        };
    }

    const status = await getNetworkStatus();

    if (status.effectiveMode === "wildcard" && status.wildcardDomain) {
        return { hostname: magicDomain(name, "", status.wildcardDomain), cert: "le", kind: "auto" };
    }
    if (status.effectiveMode === "public" && status.subdomainIp) {
        return { hostname: magicDomain(name, status.subdomainIp, DEFAULT_SUBDOMAIN_BASE), cert: "le", kind: "auto" };
    }
    if (status.subdomainIp) {
        // LAN-only but universally resolvable: a sslip.io name that public DNS maps to
        // the private IP, so it works on any LAN device with no mDNS or per-name setup
        // (unlike a *.plr.local name). Served by the internal CA and labelled. A NATed
        // box's public reachability is handled separately (an auto Cloudflare quick tunnel).
        return { hostname: magicDomain(name, status.subdomainIp, DEFAULT_SUBDOMAIN_BASE), cert: "internal", kind: "lan" };
    }
    return null;
}
