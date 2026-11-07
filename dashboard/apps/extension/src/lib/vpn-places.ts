/**
 * Where the VPN's servers are, as the popup lists them: by country, then by city,
 * with the choice Quick connect and Random make. Pure, so it is tested without a
 * browser.
 *
 * The country is the two-letter code the host read from the server's address or
 * was told; an older host sends none, and a server without one is listed under
 * "Other locations" with a globe instead of a flag.
 */

import type { VpnNode } from "@/lib/vpn";

/** One country in the list, or the servers with no country at all (`code` null). */
export interface VpnCountry {
    readonly code: string | null;
    readonly name: string;
    readonly nodes: readonly VpnNode[];
    /** How many of them a browser can use now. */
    readonly usable: number;
}

/** The recents kept, newest first. */
export const RECENT_LIMIT = 3;

/** The country code a flag can be drawn for, or null. */
export function countryCode(value: string | null | undefined): string | null {
    if (typeof value !== "string") return null;
    const upper = value.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

/** The country's name in the reader's language; the code where the browser has none. */
export function countryName(code: string, locale: string): string {
    try {
        return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
    } catch {
        return code;
    }
}

/** "City, Country", the country alone, or null when the host said neither. */
export function placeOf(node: VpnNode, locale: string): string | null {
    const code = countryCode(node.country);
    const country = code ? countryName(code, locale) : null;
    const city = node.city?.trim() || null;
    if (city && country) return `${city}, ${country}`;
    return city ?? country;
}

/** Ignores case and accents, so "espana" finds España and "sao" finds São Paulo. */
export function fold(text: string): string {
    return text
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .trim();
}

function byText(a: string, b: string, locale: string): number {
    return a.localeCompare(b, locale, { sensitivity: "base" });
}

/**
 * The servers by country, countries by name and the unplaced ones last; inside a
 * country by city, then by name.
 */
export function groupByCountry(
    nodes: readonly VpnNode[],
    locale: string,
    otherName: string
): VpnCountry[] {
    const groups = new Map<string | null, VpnNode[]>();
    for (const node of nodes) {
        const code = countryCode(node.country);
        groups.set(code, [...(groups.get(code) ?? []), node]);
    }
    const countries = [...groups].map(([code, members]) => ({
        code,
        name: code ? countryName(code, locale) : otherName,
        nodes: [...members].sort(
            (a, b) => byText(a.city ?? "", b.city ?? "", locale) || byText(a.name, b.name, locale)
        ),
        usable: members.filter((node) => node.browser).length
    }));
    return countries.sort((a, b) =>
        a.code === null ? 1 : b.code === null ? -1 : byText(a.name, b.name, locale)
    );
}

/**
 * The countries a search keeps. A country whose name or code matches keeps every
 * server; otherwise only the servers whose city or name does.
 */
export function searchCountries(countries: readonly VpnCountry[], query: string): VpnCountry[] {
    const wanted = fold(query);
    if (!wanted) return [...countries];
    return countries.flatMap((country) => {
        if (fold(country.name).includes(wanted) || fold(country.code ?? "") === wanted)
            return [country];
        const nodes = country.nodes.filter(
            (node) => fold(node.name).includes(wanted) || fold(node.city ?? "").includes(wanted)
        );
        return nodes.length
            ? [{ ...country, nodes, usable: nodes.filter((node) => node.browser).length }]
            : [];
    });
}

/** A random server a browser can use, other than the one in use; null when none is. */
export function randomPick(
    nodes: readonly VpnNode[],
    activeId: string | null,
    random: () => number = Math.random
): VpnNode | null {
    const usable = nodes.filter((node) => node.browser && node.id !== activeId);
    if (!usable.length) return null;
    return usable[Math.min(usable.length - 1, Math.floor(random() * usable.length))] ?? null;
}

/**
 * Quick connect: the most recent server still usable, so one press puts somebody
 * back where they were, and a random one the first time. Latency is not measured:
 * the proxy's address only comes with a login, and asking for one per server to
 * time it would cost more than the press saves.
 */
export function quickPick(
    nodes: readonly VpnNode[],
    recents: readonly string[],
    random: () => number = Math.random
): VpnNode | null {
    for (const id of recents) {
        const node = nodes.find((one) => one.id === id);
        if (node?.browser) return node;
    }
    return randomPick(nodes, null, random);
}

/** The recents with `id` in front, without repeats, kept to the limit. */
export function pushRecent(recents: readonly string[], id: string): string[] {
    return [id, ...recents.filter((one) => one !== id)].slice(0, RECENT_LIMIT);
}

/** What was stored as recents, read defensively: anything else is none. */
export function readRecents(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((one): one is string => typeof one === "string" && one.length > 0 && one.length < 100)
        .slice(0, RECENT_LIMIT);
}

/** The recents that are still servers this account has, in order. */
export function recentNodes(nodes: readonly VpnNode[], recents: readonly string[]): VpnNode[] {
    return recents.flatMap((id) => nodes.find((node) => node.id === id) ?? []);
}

/** The path of a vendored flag, or null where none can be drawn. */
export function flagPath(code: string | null): string | null {
    const valid = countryCode(code);
    return valid ? `/flags/${valid.toLowerCase()}.svg` : null;
}
