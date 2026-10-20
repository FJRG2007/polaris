/**
 * The domains each blocked service uses, read from AdGuard's public services
 * registry when the settings are saved.
 *
 * Downloaded rather than copied into Polaris: the registry is GPL-3.0, and it
 * changes as the services do. What is kept is only the plain names a service
 * blocks, stored with the operator's settings, so the engine gets them inline
 * and a later save with no internet keeps the names from the last one.
 *
 * Its rules are AdGuard filter syntax. The engine reads names and `*.name`
 * wildcards, so only the rules that say exactly that are kept: `||name^` (the
 * name and everything under it) and `|name^` (that name only). A rule with a
 * modifier (`$dnstype`, `$denyallow`, ...), a `*` inside a name, or a regular
 * expression is left out: read as a plain name it would block more than AdGuard
 * does - `||amazonaws.com^$dnstype=~CNAME` is not all of AWS.
 */

import { z } from "zod";
import { follow, readCapped } from "@/lib/safe-fetch";
import { DNS_LIMITS, dnsServicesInUse, normalizeDnsRule, type DnsSettings } from "./settings";

export const SERVICES_REGISTRY_URL =
    "https://adguardteam.github.io/HostlistsRegistry/assets/services.json";

/** The registry is about 260 KB; four times that is not it. */
const REGISTRY_MAX_BYTES = 1024 * 1024;

const RULE = /^(\|\|?)([a-z0-9.-]+)\^?$/;

/** The names a service's rules block, in the engine's syntax. Pure. */
export function namesFromRules(rules: readonly string[]): string[] {
    const names = new Set<string>();
    for (const rule of rules) {
        const match = RULE.exec(rule.trim().toLowerCase());
        if (!match?.[1] || !match[2]) continue;
        const name = normalizeDnsRule(match[1] === "||" ? `*.${match[2]}` : match[2]);
        if (name) names.add(name);
        if (names.size >= DNS_LIMITS.serviceDomains) break;
    }
    return [...names];
}

const registrySchema = z.object({
    blocked_services: z.array(
        z.object({ id: z.string(), rules: z.array(z.string()) }).passthrough()
    )
});

/** The names of each wanted service the registry knows. Pure. */
export function namesFromRegistry(
    registry: unknown,
    wanted: readonly string[]
): Record<string, string[]> {
    const parsed = registrySchema.safeParse(registry);
    if (!parsed.success) return {};
    const out: Record<string, string[]> = {};
    for (const service of parsed.data.blocked_services) {
        if (!wanted.includes(service.id)) continue;
        const names = namesFromRules(service.rules);
        if (names.length > 0) out[service.id] = names;
    }
    return out;
}

/** The registry's names for `wanted`, or null when it could not be read
 *  (no internet, the registry down, an answer that is not it). */
export async function fetchServiceNames(
    wanted: readonly string[]
): Promise<Record<string, string[]> | null> {
    if (wanted.length === 0) return {};
    try {
        const response = await follow(new URL(SERVICES_REGISTRY_URL), "application/json");
        if (!response?.ok) {
            await response?.body?.cancel().catch(() => undefined);
            return null;
        }
        const bytes = await readCapped(response, REGISTRY_MAX_BYTES);
        if (!bytes) return null;
        const names = namesFromRegistry(JSON.parse(new TextDecoder().decode(bytes)), wanted);
        return Object.keys(names).length > 0 ? names : null;
    } catch (error) {
        console.error("polaris: could not read the blocked services registry:", error);
        return null;
    }
}

/**
 * The names of every service in use, downloaded again on each save so they
 * follow the services, or the ones the last save stored (`kept`) when the
 * registry cannot be read. A refusal when a service has neither: saving would
 * block nothing for it while its switch says it is blocked.
 */
export async function resolveServiceNames(
    settings: Pick<DnsSettings, "services" | "clientGroups">,
    kept: Record<string, string[]>,
    fetchNames: typeof fetchServiceNames = fetchServiceNames
): Promise<
    { names: Record<string, string[]> } | { refusal: "servicesOffline" | "servicesMissing" }
> {
    const wanted = dnsServicesInUse(settings);
    if (wanted.length === 0) return { names: {} };
    const fetched = await fetchNames(wanted);
    const names: Record<string, string[]> = {};
    for (const id of wanted) {
        const found = fetched?.[id] ?? kept[id];
        if (found && found.length > 0) names[id] = found;
    }
    if (wanted.some((id) => !names[id]))
        return { refusal: fetched ? "servicesMissing" : "servicesOffline" };
    return { names };
}
