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

import {
    DNS_CATEGORIES,
    DNS_LIST_SOURCES,
    DNS_UPSTREAM_PRESETS,
    type DnsCategory,
    type DnsSettings
} from "./settings";

/** The port the engine answers its HTTP API on, inside the container. */
export const DNS_ENGINE_HTTP_PORT = 4000;

/**
 * A name that is always blocked, so Polaris can ask the blocker for it and tell
 * from the answer that blocking is on. Under `.invalid`, which no resolver on
 * the internet will ever answer (RFC 6761), so nothing real is ever caught.
 */
export const DNS_CHECK_NAME = "blocking-check.polaris.invalid";

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

/** The configuration as an object, before it is written out. Exported for tests. */
export function blockyConfig(settings: DnsSettings): Record<string, unknown> {
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
    // The engine checks a name against the allow lists of every group a client
    // blocks with before any deny list, so one copy, in the group that always
    // has a deny list, covers them all.
    const allowlists =
        settings.allow.length > 0 ? { [OWN_GROUP]: [inline(settings.allow)] } : undefined;

    const { servers, bootstrap } = upstreamsOf(settings);
    const mapping = new Map<string, string[]>();
    for (const record of settings.records) {
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
            clientGroupsBlock: { default: groups },
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
        ...(mapping.size > 0
            ? {
                  customDNS: {
                      customTTL: "5m",
                      mapping: Object.fromEntries(
                          [...mapping].map(([name, addresses]) => [name, addresses.join(",")])
                      )
                  }
              }
            : {}),
        caching: { prefetching: true },
        ports: { dns: 53, http: DNS_ENGINE_HTTP_PORT },
        // One line per query would fill the container log; the query log is
        // its own concern.
        queryLog: { type: "none" },
        log: { level: "info", format: "text", timestamp: true, privacy: false }
    };
}

/** The configuration file's text. */
export function renderBlockyConfig(settings: DnsSettings): string {
    return `${JSON.stringify(blockyConfig(settings), null, 1)}\n`;
}

/** The configuration as the one environment value the image reads. */
export function encodeBlockyConfig(settings: DnsSettings): string {
    return Buffer.from(renderBlockyConfig(settings), "utf8").toString("base64");
}
