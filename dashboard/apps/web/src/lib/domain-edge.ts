/**
 * The dashboard's own route at the edge.
 *
 * Deployed apps get their hostnames written into Traefik's watched directory as they
 * are created, but the dashboard's router comes from the compose labels, whose host
 * rule is fixed at `up` time from `POLARIS_PUBLIC_DOMAIN`. Nothing sets that variable,
 * so a domain configured in the admin panel was saved, verified, and then 404'd at the
 * edge - the record pointed here and the edge did not know the name.
 *
 * So the configured public hostnames are published the same way an app's are: a small
 * file the edge hot-reloads, written whenever the domains change and again on startup.
 * A Let's Encrypt certificate and the redirect off :80 come with it, which is what the
 * dashboard's own labels do for the local names.
 */

import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { getSetting } from "./setting-store";
import { polarisZoneHost } from "./domain-zones";
import { resolvePolarisWaf } from "./waf-service";
import type { WafCustomRule } from "@polaris/core";
import { encodeGuardRule } from "@polaris/core/waf";

/** Traefik's file-provider directory, the volume both containers mount. */
function dynamicDir(): string {
    return process.env.POLARIS_TRAEFIK_DYNAMIC_DIR ?? "/dynamic";
}

/** The origin the edge dials for the dashboard, by service DNS on the compose network.
 *  By the SERVICE name, never the container's: the container is replaced (and renamed)
 *  by every self-update, and a name that named one particular container resolves to
 *  nothing the first time it is. */
export function dashboardOrigin(): string {
    return process.env.POLARIS_WEB_ORIGIN ?? "http://web:3000";
}

const FILE = "polaris-dashboard.yml";
const ROUTER = "polaris-dashboard";
/** Its own redirect middleware: the file provider merges every file into one config,
 *  so reusing the name the app routes define would be a duplicate definition. */
const REDIRECT = `${ROUTER}-redirect-https`;
/** Between the two. Below the path routers at 100 - the terminal WebSocket and the
 *  call server, neither of which carries a host of its own and both of which have to
 *  keep winning their prefix on these hostnames - and above the compose labels' own
 *  catch-all at 10, so these hostnames get this router's certificate and firewall
 *  rather than the plain one. Stated rather than left to Traefik, which otherwise
 *  ranks by rule length: a few hostnames is enough to overtake a path. */
const PRIORITY = 50;

/** Suffixes that never get a public certificate, so an ACME order on one is an order
 *  that retries until it is rate-limited. */
const PRIVATE_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home.arpa"];

/**
 * A stored domain as the bare hostname to route, or null when it is not a public name.
 * Stored values are whatever was typed - `https://example.com/`, a trailing dot, an
 * uppercase letter - and the ones that are a LAN name or an IP are already served by
 * the compose labels and their internal certificate.
 */
export function publicHostname(value: string | null | undefined): string | null {
    if (!value) return null;
    const host = value
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
        .replace(/[/?#].*$/, "")
        .replace(/:\d+$/, "")
        .replace(/\.$/, "");
    if (!host || !host.includes(".")) return null;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host))
        return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
    if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null;
    return host;
}

/** The dashboard's own guard middlewares, named apart from the app routes' shared
 *  ones: the file provider merges every file into one config, so a repeated name is
 *  a duplicate definition. */
const WAF_CTX = `${ROUTER}-waf-ctx`;
const WAF_GUARD = `${ROUTER}-waf-guard`;

/** Base URL of the co-located edge guard, as the app routes address it. */
function guardUrl(): string {
    return process.env.POLARIS_EDGE_GUARD_URL ?? "http://polaris-edge-guard:8080";
}

/**
 * Render the edge config for a set of dashboard hostnames. Pure, so what the edge is
 * asked to serve can be asserted without a filesystem.
 *
 * `waf` is the firewall rule for Polaris itself. It applies only to these public
 * hostnames: the LAN names are served by the compose labels and have no route here,
 * which is deliberate - it is what makes "block the public internet" a setting an
 * operator can make from their own network and still undo afterwards.
 *
 * A require-login rule is not honoured here. The dashboard already has a login of its
 * own, and sending its visitors round the guard's cross-domain handoff to reach it
 * would be a redirect loop, not a second factor.
 */
export function renderDashboardConfig(hosts: readonly string[], waf?: DashboardWaf): string {
    if (hosts.length === 0) return "http: {}\n";
    const rule = hosts.map((host) => `Host(\`${host}\`)`).join(" || ");
    const allow = waf?.allow ?? [];
    const deny = waf?.deny ?? [];
    const rules = waf?.rules ?? [];
    const presets = waf?.presets ?? [];
    const browserIntegrity = waf?.browserIntegrity === true;
    const sqlInjectionProtection = waf?.sqlInjectionProtection === true;
    const xssProtection = waf?.xssProtection === true;

    const middlewares: string[] = [];
    const definitions: string[] = [
        `    ${REDIRECT}:`,
        "      redirectScheme:",
        "        scheme: https"
    ];
    if (allow.length > 0) {
        const mw = `${ROUTER}-allow`;
        middlewares.push(mw);
        definitions.push(
            `    ${mw}:`,
            "      ipAllowList:",
            `        sourceRange: [${allow.map((entry) => `"${entry}"`).join(", ")}]`
        );
    }
    if (
        deny.length > 0 ||
        presets.length > 0 ||
        rules.length > 0 ||
        browserIntegrity ||
        sqlInjectionProtection ||
        xssProtection
    ) {
        middlewares.push(WAF_CTX, WAF_GUARD);
        definitions.push(
            `    ${WAF_CTX}:`,
            "      headers:",
            "        customRequestHeaders:",
            `          X-Polaris-Waf: "${encodeGuardRule({ deny, presets, rules, requireLogin: false, browserIntegrity, sqlInjectionProtection, xssProtection })}"`,
            `    ${WAF_GUARD}:`,
            "      forwardAuth:",
            `        address: "${guardUrl()}/authz"`
        );
    }
    const httpsMiddlewares =
        middlewares.length > 0 ? [`      middlewares: [${middlewares.join(", ")}]`] : [];
    // The allowlist still applies to the :80 router; the guard does not, since that
    // router only redirects and the canonical https URL is where a request is judged.
    const httpMiddlewares = [allow.length > 0 ? `${ROUTER}-allow` : null, REDIRECT].filter(
        (name): name is string => name !== null
    );

    return [
        "http:",
        "  routers:",
        `    ${ROUTER}:`,
        `      rule: "${rule}"`,
        "      entryPoints: [websecure]",
        `      priority: ${PRIORITY}`,
        `      service: ${ROUTER}`,
        ...httpsMiddlewares,
        "      tls:",
        "        certResolver: letsencrypt",
        `    ${ROUTER}-http:`,
        `      rule: "${rule}"`,
        "      entryPoints: [web]",
        `      priority: ${PRIORITY}`,
        `      service: ${ROUTER}`,
        `      middlewares: [${httpMiddlewares.join(", ")}]`,
        "  services:",
        `    ${ROUTER}:`,
        "      loadBalancer:",
        "        servers:",
        `          - url: "${dashboardOrigin()}"`,
        "  middlewares:",
        ...definitions,
        ""
    ].join("\n");
}

/** The firewall rule for the dashboard's own ingress, as the renderer needs it. */
export interface DashboardWaf {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
    /** Managed rule-pack ids, expanded by the guard rather than sent expanded. */
    readonly presets?: readonly string[];
    readonly rules?: readonly WafCustomRule[];
    /** Refuse requests whose headers do not hold together as a browser's. */
    readonly browserIntegrity?: boolean;
    /** Refuse requests whose URL carries a SQL injection payload. */
    readonly sqlInjectionProtection?: boolean;
    /** Refuse requests whose URL carries a cross-site scripting payload. */
    readonly xssProtection?: boolean;
}

/**
 * Every public hostname the dashboard answers on: the configured app domain, the
 * sharing domain (share links and drop points are served by the dashboard itself, so
 * a route it lacks is a link that 404s), any extra domains an operator added, and the
 * Polaris zone from the guided setup.
 *
 * The zone is included on its own account rather than waiting for the setup to move
 * the app domain onto it: that move only happens once the zone has been seen answering
 * here, which it cannot do until the edge serves it.
 */
export async function dashboardHosts(): Promise<string[]> {
    const [app, sharing, extra, zone] = await Promise.all([
        getSetting("domain.app"),
        getSetting("domain.sharing"),
        getSetting("domain.extra"),
        polarisZoneHost()
    ]);
    const hosts = [app, sharing, ...parseExtra(extra), zone]
        .map(publicHostname)
        .filter((host): host is string => host !== null);
    return [...new Set(hosts)];
}

/** The extra-domain list as stored by domain-service. Read here rather than imported
 *  from there, which imports this module for the edge sync. */
function parseExtra(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((value): value is string => typeof value === "string")
            : [];
    } catch {
        return [];
    }
}

/**
 * Publish the dashboard's public hostnames to the edge. Idempotent, and best-effort in
 * the same way the local CA is: the dashboard is reachable on its local names either
 * way, so a dynamic directory that is missing (a dev run outside compose) must not turn
 * saving a domain into an error.
 */
export async function syncDashboardRoute(): Promise<void> {
    try {
        // Both reads, then one write. A failure to read the firewall rule is not
        // caught into a permissive default: writing the route without it would
        // republish the dashboard with its restrictions quietly removed, so the file
        // is left as it is and the error is reported instead.
        const [hosts, waf] = await Promise.all([dashboardHosts(), resolvePolarisWaf()]);
        // One scope, so at most one allowlist - Polaris's own rule has no parent to
        // narrow it further.
        const rule = {
            allow: waf.allowLists[0] ?? [],
            deny: waf.deny,
            presets: waf.presets,
            rules: waf.rules,
            browserIntegrity: waf.browserIntegrity,
            sqlInjectionProtection: waf.sqlInjectionProtection,
            xssProtection: waf.xssProtection
        };
        await writeFile(join(dynamicDir(), FILE), renderDashboardConfig(hosts, rule), "utf8");
        // The call server's path rides on these same hostnames and carries the same
        // allowlist, so it is rewritten here rather than at each of the half-dozen
        // places a domain or a firewall rule changes - one of which would eventually
        // be added without the other and leave the path open on a locked-down
        // instance. Imported here rather than at the top: that module reads this
        // one's hostnames.
        const { syncCallServerRoute } = await import("./chat/call-edge");
        await syncCallServerRoute();
    } catch (error) {
        console.error(
            "polaris: publishing the dashboard route failed:",
            error instanceof Error ? error.message : error
        );
    }
}
