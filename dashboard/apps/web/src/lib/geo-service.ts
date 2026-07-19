/**
 * IP geolocation for country/continent access rules on shares and drop points.
 * Resolution goes through a database cache first, so a repeated visitor never
 * hits an external provider twice and a location is remembered for the future.
 * On a miss it queries a handful of free, no-key providers in turn and keeps the
 * first answer. Private/reserved addresses (LAN, loopback) resolve to "unknown".
 *
 * Note: resolving a public IP sends it to a third-party provider - inherent to
 * IP geolocation without a local database. The allow decision (`geoAllowed`)
 * fails open on an unknown location so a provider outage cannot lock out
 * otherwise-authorized users; pair a geo rule with an IP allowlist for a hard
 * boundary. Node runtime (Prisma + fetch).
 */

import { continentOf, geoAllowed } from "@polaris/core";
import { prisma } from "@polaris/db";

/** How long a cached geolocation is trusted before a lazy refresh. */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface GeoLocation {
    countryCode: string | null;
    country: string | null;
    continent: string | null;
    source: string | null;
}

const UNKNOWN: GeoLocation = { countryCode: null, country: null, continent: null, source: null };

/** Whether an address is private/reserved (LAN, loopback) - never geolocated. */
function isPrivateAddress(ip: string): boolean {
    const value = ip.trim().toLowerCase();
    if (value === "" || value === "::1" || value === "localhost") return true;
    if (value.startsWith("127.") || value.startsWith("10.") || value.startsWith("192.168.")) return true;
    if (value.startsWith("169.254.") || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) {
        return true;
    }
    const m = /^172\.(\d+)\./.exec(value);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
    return false;
}

function fetchWithTimeout(url: string, ms = 3500): Promise<Response> {
    return fetch(url, { signal: AbortSignal.timeout(ms), headers: { "User-Agent": "Polaris" } });
}

type Provider = (ip: string) => Promise<{ countryCode: string; country: string } | null>;

const PROVIDERS: Array<{ name: string; run: Provider }> = [
    {
        name: "ip-api",
        run: async (ip) => {
            const res = await fetchWithTimeout(`http://ip-api.com/json/${ip}?fields=status,country,countryCode`);
            if (!res.ok) return null;
            const d = (await res.json()) as { status?: string; country?: string; countryCode?: string };
            if (d.status !== "success" || !d.countryCode) return null;
            return { countryCode: d.countryCode, country: d.country ?? "" };
        }
    },
    {
        name: "ipwho.is",
        run: async (ip) => {
            const res = await fetchWithTimeout(`https://ipwho.is/${ip}?fields=success,country,country_code`);
            if (!res.ok) return null;
            const d = (await res.json()) as { success?: boolean; country?: string; country_code?: string };
            if (!d.success || !d.country_code) return null;
            return { countryCode: d.country_code, country: d.country ?? "" };
        }
    },
    {
        name: "freeipapi",
        run: async (ip) => {
            const res = await fetchWithTimeout(`https://freeipapi.com/api/json/${ip}`);
            if (!res.ok) return null;
            const d = (await res.json()) as { countryCode?: string; countryName?: string };
            if (!d.countryCode) return null;
            return { countryCode: d.countryCode, country: d.countryName ?? "" };
        }
    },
    {
        name: "ipapi.co",
        run: async (ip) => {
            const res = await fetchWithTimeout(`https://ipapi.co/${ip}/json/`);
            if (!res.ok) return null;
            const d = (await res.json()) as { country_code?: string; country_name?: string; error?: boolean };
            if (d.error || !d.country_code) return null;
            return { countryCode: d.country_code, country: d.country_name ?? "" };
        }
    }
];

/** Query providers in order; the first with a country code wins. */
async function lookupFromProviders(ip: string): Promise<GeoLocation> {
    for (const provider of PROVIDERS) {
        try {
            const result = await provider.run(ip);
            if (result?.countryCode) {
                const countryCode = result.countryCode.toUpperCase();
                return {
                    countryCode,
                    country: result.country || null,
                    continent: continentOf(countryCode),
                    source: provider.name
                };
            }
        } catch {
            // Provider unreachable or malformed; try the next one.
        }
    }
    return UNKNOWN;
}

/** Resolve an IP to a location, using (and refreshing) the database cache. */
export async function resolveGeo(ip: string): Promise<GeoLocation> {
    if (isPrivateAddress(ip)) return UNKNOWN;

    const cached = await prisma.geoIpCache.findUnique({ where: { ip } }).catch(() => null);
    if (cached && Date.now() - cached.updatedAt.getTime() < CACHE_TTL_MS) {
        return {
            countryCode: cached.countryCode,
            country: cached.country,
            continent: cached.continent,
            source: cached.source
        };
    }

    const resolved = await lookupFromProviders(ip);
    // Only cache a positive resolution; a transient all-providers-failed result is
    // not worth remembering (retry next time instead of caching "unknown").
    if (resolved.countryCode) {
        await prisma.geoIpCache
            .upsert({
                where: { ip },
                create: { ip, ...resolved },
                update: resolved
            })
            .catch(() => undefined);
    }
    return resolved;
}

/**
 * Whether an IP passes a country/continent allowlist. Empty lists skip the lookup
 * entirely (no restriction). An unknown location is admitted (see module note).
 */
export async function geoAllowedForIp(
    ip: string | undefined,
    allowedCountries: readonly string[],
    allowedContinents: readonly string[]
): Promise<boolean> {
    if (allowedCountries.length === 0 && allowedContinents.length === 0) return true;
    if (!ip) return true;
    const { countryCode } = await resolveGeo(ip);
    return geoAllowed(countryCode, allowedCountries, allowedContinents);
}
