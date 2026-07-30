/**
 * The ways Polaris can put a service on the internet, ranked for the kind of server
 * it runs on. Ranking is deliberate: free before paid, your own DNS before someone
 * else's service, and fewer moving parts before more - a strategy that depends on a
 * third party can stop working for reasons the operator cannot see or fix.
 *
 * Pure data + selection, so the wizard, the server actions and the tests all agree
 * on what is offered, what it costs and what it needs.
 */

import type { ServerEnvironment } from "@polaris/core";
import type { NetworkMode } from "./network-service";

export type ExposureStrategy =
    | "own-domain"
    | "duckdns"
    | "free-subdomain"
    | "cloudflare-tunnel"
    | "quick-tunnel";

export const EXPOSURE_STRATEGIES: ExposureStrategy[] = [
    "own-domain",
    "duckdns",
    "free-subdomain",
    "cloudflare-tunnel",
    "quick-tunnel"
];

export interface StrategyMeta {
    label: string;
    /** One line on what the operator gets. */
    summary: string;
    /** Who has to keep working for the URLs to keep working. */
    dependency: string;
    /** What the operator must have or do first. */
    requires: string[];
    /** True when it serves `*.zone` hostnames, so Polaris mints URLs without more DNS. */
    wildcard: boolean;
    /** The exposure mode this strategy stores. */
    mode: NetworkMode;
    /** Whether the operator supplies a domain of their own. */
    needsDomain: boolean;
}

export const STRATEGY_META: Record<ExposureStrategy, StrategyMeta> = {
    "own-domain": {
        label: "Your own domain",
        summary: "One wildcard DNS record per zone, and Polaris issues Let's Encrypt certificates for every hostname it mints.",
        dependency: "Your registrar - nothing else in the path.",
        requires: ["A domain you control", "A public IP", "Ports 80 and 443 reaching this server"],
        wildcard: true,
        mode: "wildcard",
        needsDomain: true
    },
    duckdns: {
        label: "Free DuckDNS domain",
        summary: "A free <name>.duckdns.org with wildcard support, kept pointed at this server as your IP changes.",
        dependency: "duckdns.org, free and account-based.",
        requires: ["A DuckDNS subdomain and token", "Ports 80 and 443 reaching this server"],
        wildcard: true,
        mode: "wildcard",
        needsDomain: false
    },
    "free-subdomain": {
        label: "Free automatic subdomain",
        summary: "Instant sslip.io hostnames that encode this server's IP. No setup, no account - public if the IP is, LAN-only otherwise.",
        dependency: "sslip.io public DNS, no account.",
        requires: [],
        wildcard: true,
        mode: "auto",
        needsDomain: false
    },
    "cloudflare-tunnel": {
        label: "Cloudflare tunnel",
        summary: "An outbound tunnel exposes each service on your domain. Works with no public IP and no open ports.",
        dependency: "A Cloudflare account, and their edge on every request.",
        requires: ["A Cloudflare account", "Your domain on Cloudflare", "An API token connected under Integrations"],
        wildcard: false,
        mode: "tunnel",
        needsDomain: true
    },
    "quick-tunnel": {
        label: "Cloudflare quick link",
        summary: "A throwaway trycloudflare.com URL per service. Zero setup, but the URL changes every restart.",
        dependency: "Cloudflare, no account.",
        requires: [],
        wildcard: false,
        mode: "tunnel",
        needsDomain: false
    }
};

export interface StrategyOption {
    id: ExposureStrategy;
    meta: StrategyMeta;
    /** False when this server cannot use it; `note` says why. */
    available: boolean;
    /** Why it is recommended, or why it is unavailable. */
    note?: string;
}

export interface StrategyChoice {
    recommended: ExposureStrategy;
    options: StrategyOption[];
}

/**
 * The two ways traffic can reach this server, which is the question underneath every
 * strategy: either the ports are opened to it, or it dials out and someone else
 * accepts the traffic on its behalf. Asked first because it is the only part the
 * operator has a real opinion about - one costs an afternoon in the router, the other
 * costs an account and puts a company in the path of every request.
 */
export type ExposureApproach = "ports" | "tunnel";

export interface ApproachMeta {
    label: string;
    /** One line on what actually happens to a request. */
    summary: string;
    /** What is better about it, in the operator's terms. */
    pros: string[];
    /** What it costs them. Never omitted - a choice with no downside is a slogan. */
    cons: string[];
}

export const APPROACH_META: Record<ExposureApproach, ApproachMeta> = {
    ports: {
        label: "Open ports 80 and 443",
        summary: "Visitors connect straight to this server. Nothing sits in between, and nothing has to keep working for it except your own line.",
        pros: [
            "No third party between visitors and this server",
            "Free, with no account to create anywhere",
            "One wildcard record covers every hostname Polaris mints"
        ],
        cons: [
            "Two forwarding rules to create, in the router or in a firewall",
            "Needs a public IP that reaches this server",
            "Whoever connects sees the address of your line"
        ]
    },
    tunnel: {
        label: "Publish through a tunnel",
        summary: "This server dials out to a provider, which takes the traffic and passes it back down. Set up in Polaris, with nothing to change in the router.",
        pros: [
            "Nothing to configure in the router",
            "Works on a line where no port can be forwarded",
            "Your own address stays behind the provider"
        ],
        cons: [
            "Every request goes through the provider",
            "Needs an account with them, free tier included",
            "Speed and uptime become theirs rather than yours"
        ]
    }
};

/** Which side of the question a strategy answers. Tunnels dial out; the rest need ports. */
export function approachOf(strategy: ExposureStrategy): ExposureApproach {
    return STRATEGY_META[strategy].mode === "tunnel" ? "tunnel" : "ports";
}

export interface ApproachOption {
    id: ExposureApproach;
    meta: ApproachMeta;
    /** False when no strategy on this side works on this server. */
    available: boolean;
    /** What is different about this side on this server, when something is. */
    note?: string;
    /** Its strategies, in the same order the full list ranks them. */
    strategies: StrategyOption[];
    /** The one to select when the operator picks this side, or null if none can be. */
    best: ExposureStrategy | null;
}

export interface ApproachChoice {
    recommended: ExposureApproach;
    options: ApproachOption[];
}

/**
 * What the generic wording gets wrong on a particular server. The tunnel side reads
 * the same everywhere; the direct one does not - there is no router in a data centre,
 * and on a carrier-NAT line there is no inbound port to open at all, which the label
 * would otherwise promise.
 */
const APPROACH_NOTE: Partial<Record<ServerEnvironment, Partial<Record<ExposureApproach, string>>>> = {
    vps: { ports: "No router in the way - allow inbound 80 and 443 in your provider's firewall instead." },
    cloud: { ports: "No router in the way - allow inbound 80 and 443 in the instance's security group instead." },
    "home-cgnat": {
        ports:
            "Your ISP shares one address between its customers, so no port can be forwarded to this server." +
            " What is left on this side reaches your own network and nothing beyond it."
    }
};

/**
 * The same ranking, split in two so the setup can ask the question the operator can
 * actually answer before asking which provider. Derived from `strategiesFor` rather
 * than ranked again, so the two can never disagree about what a server can use.
 */
export function approachesFor(environment: ServerEnvironment): ApproachChoice {
    const choice = strategiesFor(environment);
    const options: ApproachOption[] = (["ports", "tunnel"] as ExposureApproach[]).map((id) => {
        const strategies = choice.options.filter((option) => approachOf(option.id) === id);
        const best = strategies.find((option) => option.available)?.id ?? null;
        const note = APPROACH_NOTE[environment]?.[id];
        return { id, meta: APPROACH_META[id], available: best !== null, ...(note ? { note } : {}), strategies, best };
    });
    return { recommended: approachOf(choice.recommended), options };
}

/** Order per environment, best first. Anything omitted is unavailable there. */
const ORDER: Record<ServerEnvironment, [ExposureStrategy, ...ExposureStrategy[]]> = {
    vps: ["own-domain", "free-subdomain", "cloudflare-tunnel", "duckdns", "quick-tunnel"],
    cloud: ["own-domain", "free-subdomain", "cloudflare-tunnel", "duckdns", "quick-tunnel"],
    "home-nat": ["own-domain", "duckdns", "cloudflare-tunnel", "free-subdomain", "quick-tunnel"],
    // A tunnel is the only thing that reaches a carrier-NAT line at all, so the
    // ranking there is between tunnels rather than against a wildcard record.
    "home-cgnat": ["cloudflare-tunnel", "quick-tunnel", "free-subdomain"],
    unknown: ["free-subdomain", "own-domain", "duckdns", "cloudflare-tunnel", "quick-tunnel"]
};

/** Why the top option is the top option, in the operator's terms. */
const RECOMMENDATION: Record<ServerEnvironment, string> = {
    vps: "This server holds its own public IP, so a wildcard record pointed straight at it is the shortest path - free and with nobody in between.",
    cloud: "The instance is publicly addressable, so a wildcard record pointed straight at it is the shortest path. Allow 80 and 443 in its security group.",
    "home-nat": "Your router owns a public IP, so forwarding 80 and 443 gives you real domains with no third-party service in the path.",
    "home-cgnat": "Your ISP shares one address between customers, so no port can be forwarded to this server. An outbound tunnel is the only thing that reaches it.",
    unknown: "Answer where this server lives to get a recommendation that matches it. Free subdomains work either way in the meantime."
};

/** Why a strategy is not offered on this kind of server. */
function unavailableNote(strategy: ExposureStrategy, environment: ServerEnvironment): string {
    if (environment !== "home-cgnat") return "";
    if (strategy === "own-domain") return "Needs a public IP that reaches this server; carrier NAT gives you none.";
    if (strategy === "duckdns") return "Would point at your carrier's shared address, which does not reach this server.";
    return "";
}

/** The strategies offered for a server, best first, with the recommended one flagged. */
export function strategiesFor(environment: ServerEnvironment): StrategyChoice {
    const order = ORDER[environment] ?? ORDER.unknown;
    const options: StrategyOption[] = EXPOSURE_STRATEGIES.slice()
        .sort((a, b) => rank(order, a) - rank(order, b))
        .map((id) => {
            const available = order.includes(id);
            const note = available
                ? id === order[0]
                    ? RECOMMENDATION[environment]
                    : undefined
                : unavailableNote(id, environment) || "Not available on this kind of server.";
            return { id, meta: STRATEGY_META[id], available, note };
        });
    return { recommended: order[0], options };
}

function rank(order: ExposureStrategy[], id: ExposureStrategy): number {
    const index = order.indexOf(id);
    return index === -1 ? order.length + EXPOSURE_STRATEGIES.indexOf(id) : index;
}
