/**
 * Network topology and exposure strategy. Classifies the box Polaris runs on -
 * cloud VM, VPS, home LAN behind a router, or a carrier-NAT line (the
 * `ServerEnvironment` taxonomy in @polaris/core, which registered SSH hosts share)
 * - and derives how auto-generated domains should be exposed so an app never gets
 * a subdomain that silently does not work off the LAN.
 *
 * Detection is a starting point, not the truth: the operator can answer where the
 * box lives and can override the exposure mode and wildcard domain. Config lives
 * in the Setting table (no schema change).
 */

import { DEFAULT_SUBDOMAIN_BASE, magicDomain } from "@polaris/deploy";
import {
    isCarrierGradeNat,
    isIpv4,
    isPrivateIp,
    isPublicIpv4,
    SERVER_ENVIRONMENTS,
    serverEnvironmentGroup,
    type ServerEnvironment
} from "@polaris/core";
import { deployBase, duckdnsConfigured, getPublicIp } from "./domain-service";
import { deployZoneBase, zoneDnsVerified } from "./domain-zones";
import { getSetting, setSetting } from "./setting-store";

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
    environment: "network.environment",
    detectedEnvironment: "network.detectedEnvironment",
    detectedEnvironmentAt: "network.detectedEnvironmentAt",
    detectedEnvironmentIp: "network.detectedEnvironmentIp"
} as const;

/** Where Polaris is hosted, inferred from cloud signals. */
export type ServerPlacement = "cloud" | "home" | "unknown";

/** True when a cloud metadata service answers on the 169.254.169.254 link-local
 *  address (200 on IMDSv1, 401 on IMDSv2, 403/404 elsewhere - any answer counts):
 *  only a cloud network routes it, so this is the strongest "this is a VM" signal. */
async function cloudMetadataReachable(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
        await fetch("http://169.254.169.254/latest/meta-data/", {
            cache: "no-store",
            signal: controller.signal,
            headers: { "Metadata-Flavor": "Google" }
        });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** A stored setting read back as an environment, or null when absent or from a
 *  version that knew a value this one does not. */
function asEnvironment(value: string | null): ServerEnvironment | null {
    return value && SERVER_ENVIRONMENTS.includes(value as ServerEnvironment) ? (value as ServerEnvironment) : null;
}

/**
 * Classify the box Polaris runs on. After the cloud-metadata probe the shape of
 * the box's own address decides: a public address is a VPS/dedicated server,
 * carrier-NAT space a home line with no inbound ports, a private address a
 * home/office LAN box.
 *
 * Only the metadata probe is conclusive - it reads the network itself, and a VM
 * does not move - so a `cloud` answer is cached for the life of the machine. The
 * address-shape guesses read the operator-editable public IP, so they are cached
 * only for the detection TTL and are dropped as soon as that IP changes:
 * otherwise a home server whose ISP address gets configured stays misclassified
 * as a VPS forever, and the exposure guidance with it.
 */
export async function detectLocalEnvironment(force = false): Promise<ServerEnvironment> {
    const ownIp = await getPublicIp();
    if (!force) {
        const cached = asEnvironment(await getSetting(KEYS.detectedEnvironment));
        if (cached === "cloud") return cached;
        if (cached) {
            const at = Number(await getSetting(KEYS.detectedEnvironmentAt));
            const from = await getSetting(KEYS.detectedEnvironmentIp);
            const fresh = Number.isFinite(at) && Date.now() - at < DETECT_TTL_MS;
            if (fresh && from === (ownIp ?? "")) return cached;
        }
    }
    let environment: ServerEnvironment = "unknown";
    if (await cloudMetadataReachable()) {
        environment = "cloud";
    } else if (ownIp && isCarrierGradeNat(ownIp)) {
        environment = "home-cgnat";
    } else if (ownIp && !isPrivateIp(ownIp)) {
        environment = "vps";
    } else {
        // Only worth the echo-service walk when the box's own address says nothing.
        const externalIp = await detectPublicIp(force);
        if (externalIp) environment = isCarrierGradeNat(externalIp) ? "home-cgnat" : "home-nat";
    }
    await setSetting(KEYS.detectedEnvironment, environment);
    await setSetting(KEYS.detectedEnvironmentAt, String(Date.now()));
    await setSetting(KEYS.detectedEnvironmentIp, ownIp ?? "");
    return environment;
}

export interface LocalEnvironment {
    /** The classification to act on: the operator's answer, else the detection. */
    environment: ServerEnvironment;
    /** What Polaris detected on its own, offered as the default when asking. */
    detected: ServerEnvironment;
    /** True when the operator answered, so the value is not just a guess. */
    confirmed: boolean;
}

/** Where the Polaris box lives, preferring the operator's answer over detection:
 *  no probe can see a router's port forwarding or a CGNAT line from the inside. */
export async function getLocalEnvironment(force = false): Promise<LocalEnvironment> {
    const stored = asEnvironment(await getSetting(KEYS.environment));
    const answered = stored && stored !== "unknown" ? stored : null;
    // An answered box never pays for the probes: the answer wins anyway and the
    // suggestion is only offered while there is none. Report the last detection as
    // it stands rather than running a fresh one behind a render.
    if (answered && !force) {
        const detected = asEnvironment(await getSetting(KEYS.detectedEnvironment)) ?? "unknown";
        return { environment: answered, detected, confirmed: true };
    }
    const detected = await detectLocalEnvironment(force);
    return { environment: answered ?? detected, detected, confirmed: Boolean(answered) };
}

/** Store the operator's answer for the local box ("unknown" clears it, so
 *  detection takes over again). */
export async function setLocalEnvironment(environment: ServerEnvironment): Promise<void> {
    await setSetting(KEYS.environment, environment === "unknown" ? null : environment);
}

/**
 * Coarse hosting group for the exposure guidance, derived from the environment.
 * Never probes on its own: `getNetworkStatus` is awaited on request paths that
 * must stay fast (share links, domain resolution), so this reads the operator's
 * answer and the last detection and settles for "unknown" rather than blocking a
 * request on the metadata and echo-service walks. Pass `force` from an explicit
 * re-detect action to refresh it.
 */
export async function detectPlacement(force = false): Promise<ServerPlacement> {
    let environment: ServerEnvironment;
    if (force) {
        environment = (await getLocalEnvironment(true)).environment;
    } else {
        const answered = asEnvironment(await getSetting(KEYS.environment));
        const detected = asEnvironment(await getSetting(KEYS.detectedEnvironment));
        // Nothing known yet (a fresh install): warm the cache in the background so
        // the next load is classified, rather than reporting "unknown" until
        // someone opens Servers or hits re-detect.
        if (!answered && !detected) void detectLocalEnvironment().catch(() => undefined);
        environment = answered ?? detected ?? "unknown";
    }
    const group = serverEnvironmentGroup(environment);
    if (group === "datacenter") return "cloud";
    return group === "home" ? "home" : "unknown";
}

/** Re-detect the public IP if the cached value is older than this. */
const DETECT_TTL_MS = 6 * 60 * 60 * 1000;


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
    /** True when it comes from the zone layout, so editing it here would be ignored. */
    wildcardManaged: boolean;
    /** True when the wildcard can be handed out: a zone's DNS has been seen resolving
     *  here, or the domain was named by hand and is the operator's own statement. */
    wildcardReady: boolean;
    /** The free-subdomain magic base (sslip.io by default). */
    subdomainBase: string;
    /** Whether the box looks like a cloud VM or a home/office server. */
    placement: ServerPlacement;
    /** Whether a DuckDNS subdomain + token are configured. */
    duckdns: boolean;
}

export async function getNetworkStatus(): Promise<NetworkStatus> {
    const [storedMode, storedWildcard, zoneBase, zoneVerified, subdomainIp, publicIp, base, placement, duckdns] =
        await Promise.all([
            getSetting(KEYS.mode),
            getSetting(KEYS.wildcardDomain),
            deployZoneBase(),
            zoneDnsVerified(),
            getPublicIp(),
            detectPublicIp(),
            deployBase(),
            detectPlacement(),
            duckdnsConfigured()
        ]);
    // The zone layout is the source of truth once a base domain is configured: the
    // guided setup writes it, and every deploy zone already carries its own wildcard
    // record. The standalone field stays as the fallback for setups that predate it.
    const wildcard = zoneBase ?? storedWildcard;
    const mode = MODES.includes(storedMode as NetworkMode) ? (storedMode as NetworkMode) : "auto";
    // IPv4 only: the free subdomain encodes the address in a DNS label, which a
    // public IPv6 cannot survive - treating one as reachable would mint a hostname
    // with colons in it and ask Let's Encrypt to certify it.
    const autoSubdomainsPublic = Boolean(subdomainIp) && isPublicIpv4(subdomainIp!);
    const natted = !autoSubdomainsPublic || (Boolean(publicIp) && publicIp !== subdomainIp);
    // A zone layout is an intention until its wildcard has been seen resolving to this
    // server, so the wildcard is only exposed once the DNS check has passed: minting
    // `<app>.plr.example.com` before the record exists hands out a hostname nothing
    // resolves and asks Let's Encrypt to validate it, once per service. Until then the
    // free subdomain stays, and the mode flips on its own when the check succeeds. The
    // legacy standalone field is the operator's own statement about DNS they manage, so
    // it needs no proof - but it does not promote the mode on its own either.
    const wildcardReady = zoneBase ? zoneVerified : Boolean(storedWildcard);
    const fallbackMode: EffectiveMode = autoSubdomainsPublic ? "public" : "lan";
    const effectiveMode: EffectiveMode =
        mode === "auto"
            ? zoneBase && zoneVerified
                ? "wildcard"
                : fallbackMode
            : mode === "wildcard" && !wildcardReady
              ? fallbackMode
              : mode;
    return {
        mode,
        effectiveMode,
        subdomainIp,
        publicIp,
        natted,
        autoSubdomainsPublic,
        wildcardDomain: wildcard ?? "",
        wildcardManaged: Boolean(zoneBase),
        wildcardReady,
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
export async function resolveAutoDomain(
    name: string,
    override?: { ip: string; wildcard?: string | null }
): Promise<AutoDomainPlan | null> {
    // An app on a remote server gets a subdomain that embeds THAT server's IP and
    // is served by its own edge, so it never inherits the Polaris host's IP or
    // network mode: a public IP earns a real Let's Encrypt name, a private one a
    // LAN-only internal name. The wildcard/mode logic below is for the local host.
    if (override) {
        // A wildcard pointed at that server is a real domain its own edge serves, so
        // it beats the IP-derived name - and it is the only option when the server is
        // reached by hostname, where there is no address to encode.
        const wildcard = override.wildcard?.trim();
        if (wildcard) return { hostname: magicDomain(name, "", wildcard), cert: "le", kind: "auto" };
        const ip = override.ip.trim();
        // The subdomain encodes the address in a DNS label, so a host reached by
        // name or over IPv6 has no auto domain to offer - the caller falls back.
        if (!isIpv4(ip)) return null;
        const publicIp = !isPrivateIp(ip);
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
