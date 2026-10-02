/**
 * Gathering the facts an audit judges, from public data only: DNS asked of the
 * public resolvers, DNSSEC over DNS-over-HTTPS, the registry's RDAP, and the
 * domain's own web and mail-policy servers.
 *
 * Everything the network does is behind `Probes`, so the orchestration here is
 * tested with a fake one. Every probe is bounded by the probe (timeouts, byte
 * caps); this file bounds how many it starts - a fixed list of names per domain,
 * at most `MAX_ALIASES` aliases checked for dangling targets, and the DKIM
 * selectors a few at a time.
 */

import type * as F from "./facts";
import { caaTagValue } from "@/lib/dns/public-resolver";
import { COMMON_DKIM_SELECTORS, externalReportHosts } from "./evaluate";
import { isDmarc, isSpf, parseSpf, walkSpf, type SpfResolver } from "./records";

/** The DNS questions an audit asks, as node's resolver answers them. */
export interface DnsAsk {
    resolveMx(name: string): Promise<{ priority: number; exchange: string }[]>;
    resolveTxt(name: string): Promise<string[][]>;
    resolveNs(name: string): Promise<string[]>;
    resolveCaa(name: string): Promise<{ critical: number; issue?: string; issuewild?: string; iodef?: string }[]>;
    resolve4(name: string): Promise<string[]>;
    resolve6(name: string): Promise<string[]>;
    resolveCname(name: string): Promise<string[]>;
}

export interface Probes {
    readonly dns: DnsAsk;
    /** DNSSEC: whether a DS (or DNSKEY) exists, and whether a validating resolver
     *  vouched for the answer. null when the resolver did not answer. */
    dnssec(name: string, type: "DS" | "DNSKEY"): Promise<{ present: boolean; validated: boolean } | null>;
    /** Whether a name server hands out the zone. null when it could not be asked. */
    axfr(server: string, domain: string): Promise<boolean | null>;
    registration(domain: string): Promise<F.RegistrationFacts | null>;
    web(domain: string, servedByPolaris: boolean): Promise<F.WebFacts | null>;
    mtaStsPolicy(domain: string): Promise<F.MtaStsFetch>;
    /** A DKIM public key's size in bits, null when it does not read. */
    keyBits(base64: string, keyType: string): number | null;
    /** A random label, for asking whether a wildcard answers. */
    randomLabel(): string;
}

/** Aliases looked at for a dangling target, at most. */
export const MAX_ALIASES = 40;

/** Name servers asked for a transfer, at most. */
const MAX_AXFR_SERVERS = 4;

/** DKIM selectors asked at once. */
const DKIM_PARALLEL = 6;

export interface CollectInput {
    readonly domain: string;
    readonly context: F.DomainContext;
    /** DKIM selectors Polaris knows for this domain (its mail server's own). */
    readonly selectors: readonly string[];
    /** Names under the domain whose aliases are worth checking: every CNAME of a
     *  zone Polaris reads, or the hostnames Polaris serves there. Each with its
     *  target when the zone already said it. */
    readonly aliases: readonly { readonly name: string; readonly target?: string }[];
    readonly servedByPolaris: boolean;
}

function code(error: unknown): string | undefined {
    return (error as { code?: string })?.code;
}

/** A lookup's answer, [] for "no such name" and "no data" (those are answers),
 *  null for a resolver that did not answer at all. */
async function answer<T>(ask: () => Promise<T[]>): Promise<T[] | null> {
    try {
        return await ask();
    } catch (error) {
        const kind = code(error);
        if (kind === "ENOTFOUND" || kind === "ENODATA") return [];
        return null;
    }
}

async function txt(dns: DnsAsk, name: string): Promise<string[] | null> {
    const found = await answer(() => dns.resolveTxt(name));
    return found === null ? null : found.map((chunks) => chunks.join(""));
}

/** Run `work` over `items`, `width` at a time. */
async function inBatches<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    for (let start = 0; start < items.length; start += width) {
        results.push(...(await Promise.all(items.slice(start, start + width).map(work))));
    }
    return results;
}

async function collectDkim(input: CollectInput, probes: Probes): Promise<{ found: F.DkimFound[] | null; tried: string[] }> {
    const tried = [...new Set([...input.selectors, ...COMMON_DKIM_SELECTORS])];
    const answers = await inBatches(tried, DKIM_PARALLEL, async (selector) => ({
        selector,
        texts: await txt(probes.dns, `${selector}._domainkey.${input.domain}`)
    }));
    // A domain whose every selector went unanswered was not looked at, which is
    // not the same as having no keys.
    if (answers.every((entry) => entry.texts === null)) return { found: null, tried };
    const found: F.DkimFound[] = [];
    for (const entry of answers) {
        const text = entry.texts?.find((value) => /(^|;)\s*p\s*=/i.test(value));
        if (!text) continue;
        const key = /(?:^|;)\s*p\s*=\s*([^;]*)/i.exec(text)?.[1]?.replace(/\s+/g, "") ?? "";
        const type = /(?:^|;)\s*k\s*=\s*([^;\s]*)/i.exec(text)?.[1]?.toLowerCase() ?? "rsa";
        found.push({ selector: entry.selector, text, bits: key ? probes.keyBits(key, type) : null });
    }
    // A wildcard key answers for a selector nobody uses: the lockdown's empty one.
    if (found.length === 0) {
        const wildcard = await txt(probes.dns, `${probes.randomLabel()}._domainkey.${input.domain}`);
        const text = wildcard?.find((value) => /(^|;)\s*p\s*=/i.test(value));
        if (text) found.push({ selector: "*", text, bits: null });
    }
    return { found, tried };
}

async function collectNs(domain: string, probes: Probes): Promise<F.NameServer[] | null> {
    const names = await answer(() => probes.dns.resolveNs(domain));
    if (names === null) return null;
    return Promise.all(
        names.slice(0, 8).map(async (name) => ({
            name: name.toLowerCase(),
            addresses: [...((await answer(() => probes.dns.resolve4(name))) ?? []), ...((await answer(() => probes.dns.resolve6(name))) ?? [])]
        }))
    );
}

/** Aliases whose target no longer exists: the shape of a subdomain takeover. */
async function collectDangling(input: CollectInput, probes: Probes): Promise<{ dangling: { name: string; target: string }[]; checked: number }> {
    const aliases = input.aliases.slice(0, MAX_ALIASES);
    const checked = await inBatches(aliases, DKIM_PARALLEL, async (alias) => {
        const target = alias.target ?? (await answer(() => probes.dns.resolveCname(alias.name)))?.[0] ?? null;
        if (!target) return null;
        const clean = target.toLowerCase().replace(/\.$/, "");
        try {
            await probes.dns.resolve4(clean);
            return { name: alias.name, target: clean, dangling: false };
        } catch (error) {
            if (code(error) !== "ENOTFOUND") {
                // No A is not dangling: the target may answer on IPv6, or be an
                // alias itself. Only a name that does not exist is.
                return { name: alias.name, target: clean, dangling: false };
            }
            const v6 = await answer(() => probes.dns.resolve6(clean));
            return { name: alias.name, target: clean, dangling: v6 !== null && v6.length === 0 };
        }
    });
    const looked = checked.filter((entry): entry is { name: string; target: string; dangling: boolean } => entry !== null);
    return { dangling: looked.filter((entry) => entry.dangling).map(({ name, target }) => ({ name, target })), checked: looked.length };
}

async function collectAuthorization(domain: string, dmarcTxt: readonly string[] | null, probes: Probes): Promise<Record<string, boolean | null>> {
    const record = dmarcTxt?.filter(isDmarc);
    if (!record || record.length !== 1) return {};
    const hosts = externalReportHosts(domain, record[0]!).slice(0, 3);
    const result: Record<string, boolean | null> = {};
    for (const host of hosts) {
        const texts = await txt(probes.dns, `${domain}._report._dmarc.${host}`);
        result[host] = texts === null ? null : texts.some((text) => /^v=DMARC1/i.test(text.trim()));
    }
    return result;
}

async function collectSpf(domain: string, apexTxt: readonly string[] | null, probes: Probes) {
    const records = apexTxt?.filter(isSpf);
    if (!records || records.length !== 1) return null;
    const parsed = parseSpf(records[0]!);
    if (!parsed.ok) return null;
    const resolver: SpfResolver = {
        txt: async (name) => (await txt(probes.dns, name)) ?? [],
        exists: async (name, kind) => {
            if (kind === "mx") return ((await answer(() => probes.dns.resolveMx(name))) ?? []).length > 0;
            const v4 = (await answer(() => probes.dns.resolve4(name))) ?? [];
            if (v4.length > 0) return true;
            return ((await answer(() => probes.dns.resolve6(name))) ?? []).length > 0;
        }
    };
    return walkSpf(domain, parsed, resolver);
}

/** Every fact about one domain. Never throws: a probe that fails is a fact
 *  nobody could find out. */
export async function collectFacts(input: CollectInput, probes: Probes): Promise<F.DomainFacts> {
    const { domain } = input;
    const dns = probes.dns;
    const [mx, apexTxt, dmarcTxt, mtaStsTxt, tlsRptTxt, bimiTxt, caaRaw, ns, wildcard, ds, dnskey, registration, web, dkim, dangling] =
        await Promise.all([
            answer(() => dns.resolveMx(domain)),
            txt(dns, domain),
            txt(dns, `_dmarc.${domain}`),
            txt(dns, `_mta-sts.${domain}`),
            txt(dns, `_smtp._tls.${domain}`),
            txt(dns, `default._bimi.${domain}`),
            answer(() => dns.resolveCaa(domain)),
            collectNs(domain, probes),
            answer(() => dns.resolve4(`${probes.randomLabel()}.${domain}`)).then((found) => (found === null ? null : found.length > 0)),
            probes.dnssec(domain, "DS").catch(() => null),
            probes.dnssec(domain, "DNSKEY").catch(() => null),
            probes.registration(domain).catch(() => null),
            probes.web(domain, input.servedByPolaris).catch(() => null),
            collectDkim(input, probes),
            collectDangling(input, probes)
        ]);

    const [spfWalk, ruaAuthorization, mtaStsPolicy, axfr] = await Promise.all([
        collectSpf(domain, apexTxt, probes),
        collectAuthorization(domain, dmarcTxt, probes),
        mtaStsTxt && mtaStsTxt.some((text) => /^v=STSv1/i.test(text.trim()))
            ? probes.mtaStsPolicy(domain).catch((): F.MtaStsFetch => ({ status: "unreachable" }))
            : Promise.resolve(null),
        Promise.all(
            (ns ?? []).slice(0, MAX_AXFR_SERVERS).map(async (server) => ({
                server: server.name,
                open: await probes.axfr(server.name, domain).catch(() => null)
            }))
        )
    ]);

    return {
        domain,
        mx: mx?.map((entry) => ({ priority: entry.priority, exchange: entry.exchange.replace(/\.$/, "").toLowerCase() })) ?? null,
        apexTxt,
        spfWalk,
        dmarcTxt,
        ruaAuthorization,
        dkim: dkim.found,
        dkimSelectorsTried: dkim.tried,
        mtaStsTxt,
        mtaStsPolicy,
        tlsRptTxt,
        bimiTxt,
        // Validation is the zone's own keys vouched for through the chain - the
        // AD bit on its DNSKEY answer - which only means anything once a DS
        // anchors it in the parent.
        dnssec: { ds: ds?.present ?? null, dnskey: dnskey?.present ?? null, validated: ds?.present ? (dnskey?.validated ?? null) : null },
        caa:
            caaRaw?.map((entry) => ({ flags: entry.critical, ...caaTagValue(entry) })) ?? null,
        ns,
        axfr,
        dangling: dangling.dangling,
        danglingChecked: dangling.checked,
        wildcard,
        registration,
        web,
        context: input.context
    };
}
