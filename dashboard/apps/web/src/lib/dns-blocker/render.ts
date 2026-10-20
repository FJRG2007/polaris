/**
 * The engine's configuration file, rendered from the operator's settings.
 *
 * Pure, so every shape it can produce is asserted in a test: a configuration the
 * engine refuses is a resolver that does not start, and every device on the
 * network loses names at once.
 *
 * Written as JSON, which is a subset of the YAML the engine reads. That keeps
 * quoting out of hand-written string building: a rule or a list address cannot
 * break the file whatever characters it holds.
 */

import { QUERY_LOG_DIR } from "./query-log";
import { engineSchedules } from "./schedules";
import { safeSearchAliases } from "./safe-search";
import {
    DNS_CATEGORIES,
    DNS_CHECK_NAME,
    DNS_LIST_SOURCES,
    DNS_UPSTREAM_PRESETS,
    type DnsCategory,
    type DnsSettings
} from "./settings";

/** The port the engine answers its HTTP API on, inside the container. */
export const DNS_ENGINE_HTTP_PORT = 4000;

/** The group holding the operator's own blocked names. */
const OWN_GROUP = "polaris";

/** Resolvers used when the operator typed their own and those need finding. */
const FALLBACK_BOOTSTRAP = ["1.1.1.1", "9.9.9.9"];

/** One inline list: the engine reads a value with a line break as the list
 *  itself rather than a path, so even a single entry ends with one. */
function inline(entries: readonly string[]): string {
    return `${entries.join("\n")}\n`;
}

function upstreamsOf(settings: DnsSettings): { servers: string[]; bootstrap: string[] } {
    if (settings.upstream === "custom" && settings.customUpstreams.length > 0) {
        const encrypted = settings.customUpstreams.some((server) => !/^[\d.:]+$/.test(server));
        return {
            servers: [...settings.customUpstreams],
            bootstrap: encrypted ? FALLBACK_BOOTSTRAP : []
        };
    }
    const preset =
        DNS_UPSTREAM_PRESETS.find((item) => item.id === settings.upstream) ??
        DNS_UPSTREAM_PRESETS[0]!;
    return { servers: [...preset.servers], bootstrap: [...preset.bootstrap] };
}

/** The configuration as an object, before it is written out. Exported for tests.
 *  `now` places the schedules: they are written in UTC with the zone's offset then. */
export function blockyConfig(
    settings: DnsSettings,
    now: Date = new Date()
): Record<string, unknown> {
    const enabled = new Set(settings.sources);
    const denylists: Record<string, string[]> = {};
    const add = (category: DnsCategory, entry: string) => {
        (denylists[category] ??= []).push(entry);
    };
    for (const source of DNS_LIST_SOURCES)
        if (enabled.has(source.id)) add(source.category, source.url);
    for (const list of settings.customLists) add(list.category, list.url);
    denylists[OWN_GROUP] = [inline([DNS_CHECK_NAME, ...settings.deny])];

    const groups = [...DNS_CATEGORIES.filter((category) => denylists[category]), OWN_GROUP];
    const clientGroupsBlock: Record<string, string[]> = { default: groups };
    // A device in a group blocks that group's categories (of the ones that
    // have a list) and the operator's own names, which hold the check name.
    // A device named by two groups takes the first.
    for (const group of settings.clientGroups) {
        const blocks = [
            ...DNS_CATEGORIES.filter(
                (category) => denylists[category] && group.categories.includes(category)
            ),
            OWN_GROUP
        ];
        for (const client of group.clients) clientGroupsBlock[client] ??= blocks;
    }
    // The engine checks a name against the allow lists of every group a client
    // blocks with before any deny list, so one copy, in the group that always
    // has a deny list, covers them all.
    const allowlists =
        settings.allow.length > 0 ? { [OWN_GROUP]: [inline(settings.allow)] } : undefined;

    // Never the operator's own group: it holds the name the status check asks for.
    const scheduled = engineSchedules(
        settings.schedules,
        settings.timeZone,
        new Set(Object.keys(denylists).filter((group) => group !== OWN_GROUP)),
        now
    );

    const { servers, bootstrap } = upstreamsOf(settings);
    const aliased = new Set(settings.aliases.map((alias) => alias.name));
    const recorded = new Set(settings.records.map((record) => record.name));
    // A name the operator answers themselves keeps their answer.
    const safe = safeSearchAliases(settings).filter(
        (alias) => !aliased.has(alias.name) && !recorded.has(alias.name)
    );
    const zoned = [...settings.aliases, ...safe];
    const mapping = new Map<string, string[]>();
    for (const record of settings.records) {
        // The engine lets a zone entry replace a mapped one of the same name,
        // so a name that is an alias is written only as the alias.
        if (aliased.has(record.name)) continue;
        const addresses = mapping.get(record.name) ?? [];
        if (!addresses.includes(record.address)) addresses.push(record.address);
        mapping.set(record.name, addresses);
    }

    return {
        upstreams: {
            groups: { default: servers },
            strategy: "parallel_best",
            timeout: "2s",
            // Answer at once and reach the resolvers in the background, so a
            // resolver that is slow to come up does not keep the network nameless.
            init: { strategy: "fast" }
        },
        ...(bootstrap.length > 0 ? { bootstrapDns: bootstrap.map((ip) => `tcp+udp:${ip}`) } : {}),
        blocking: {
            denylists,
            ...(allowlists ? { allowlists } : {}),
            clientGroupsBlock,
            ...(scheduled ?? {}),
            blockType: "zeroIp",
            blockTTL: "1m",
            loading: {
                refreshPeriod: `${settings.refreshHours}h`,
                // Serve names while the lists download, rather than holding
                // every device's lookups until the slowest list arrives.
                strategy: "fast",
                downloads: { timeout: "60s", attempts: 3, cooldown: "2s" },
                maxErrorsPerSource: -1
            }
        },
        ...(mapping.size > 0 || zoned.length > 0
            ? {
                  customDNS: {
                      customTTL: "5m",
                      ...(mapping.size > 0
                          ? {
                                mapping: Object.fromEntries(
                                    [...mapping].map(([name, addresses]) => [
                                        name,
                                        addresses.join(",")
                                    ])
                                )
                            }
                          : {}),
                      // Aliases (CNAME) can only be written as a zone file; every
                      // name is absolute, so no origin is needed.
                      ...(zoned.length > 0 ? { zone: zoneOf(zoned) } : {})
                  }
              }
            : {}),
        ...(settings.forwards.length > 0 ? { conditional: { mapping: forwardsOf(settings) } } : {}),
        ...(settings.namesFrom || settings.devices.length > 0
            ? { clientLookup: clientLookupOf(settings) }
            : {}),
        // Read on the container's loopback only (the HTTP port is never
        // published): how many names each category's lists hold, and when they
        // were last loaded.
        prometheus: { enable: true, path: "/metrics" },
        caching: { prefetching: true },
        ports: { dns: 53, http: DNS_ENGINE_HTTP_PORT },
        // One file a day on the engine's own volume, read back by the screen;
        // a day more than asked, so the oldest day is still whole.
        queryLog: { type: "csv", target: QUERY_LOG_DIR, logRetentionDays: settings.logDays + 1 },
        log: { level: "info", format: "text", timestamp: true, privacy: false }
    };
}

/** Each forwarded domain and the servers it goes to, in the order typed. */
function forwardsOf(settings: DnsSettings): Record<string, string> {
    const mapping = new Map<string, string[]>();
    for (const forward of settings.forwards) {
        const servers = mapping.get(forward.domain) ?? [];
        if (!servers.includes(forward.server)) servers.push(forward.server);
        mapping.set(forward.domain, servers);
    }
    return Object.fromEntries([...mapping].map(([domain, servers]) => [domain, servers.join(",")]));
}

/** Where device names come from: the ones typed here, then the router. */
function clientLookupOf(settings: DnsSettings): Record<string, unknown> {
    const clients = new Map<string, string[]>();
    for (const device of settings.devices) {
        const addresses = clients.get(device.name) ?? [];
        if (!addresses.includes(device.address)) addresses.push(device.address);
        clients.set(device.name, addresses);
    }
    return {
        ...(settings.namesFrom ? { upstream: settings.namesFrom, singleNameOrder: [1] } : {}),
        ...(clients.size > 0 ? { clients: Object.fromEntries(clients) } : {})
    };
}

/** The aliases as zone-file lines, one CNAME each. Exported for tests. */
export function aliasZone(settings: DnsSettings): string {
    return zoneOf(settings.aliases);
}

function zoneOf(aliases: readonly { name: string; target: string }[]): string {
    return inline(aliases.map((alias) => `${alias.name}. 300 IN CNAME ${alias.target}.`));
}

/** The configuration file's text. */
export function renderBlockyConfig(settings: DnsSettings, now?: Date): string {
    return `${JSON.stringify(blockyConfig(settings, now), null, 1)}\n`;
}

/** The configuration as the one environment value the image reads. */
export function encodeBlockyConfig(settings: DnsSettings, now?: Date): string {
    return Buffer.from(renderBlockyConfig(settings, now), "utf8").toString("base64");
}
