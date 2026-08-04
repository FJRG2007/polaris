/**
 * Modular edge router. Each connected server has its own edge (Traefik), and this
 * is the seam that writes an edge's dynamic routing config. A `LocalRouter` writes
 * the Polaris host's own edge (the shared `/dynamic` volume the local Traefik
 * watches); a future `RemoteRouter` will push the same config to a remote server's
 * edge over SSH. Keeping the request path on the server that runs the app is what
 * stops the control plane from becoming a single point of failure - see the deploy
 * topology notes.
 *
 * The WAF materializes here too. An IP allowlist becomes native Traefik
 * `ipAllowList` middlewares (one per scope, chained so they AND). A denylist or a
 * require-login rule becomes two chained middlewares: a `headers` middleware that
 * stamps the route's rule onto an `X-Polaris-Waf` request header (Traefik sets it,
 * so a client cannot forge it), and a shared `forwardAuth` middleware that lets the
 * co-located `polaris-edge-guard` read that header and decide. The guard is
 * therefore stateless - all rule state lives in the edge config itself - so the WAF
 * keeps enforcing when Polaris is down, on both the local and remote edges.
 */

import { writeFile } from "node:fs/promises";
import { encodeGuardRule, signEdgeOrigin } from "@polaris/core/waf";
import type { WafCustomRule, WafPrincipalGrant } from "@polaris/core";

/** One app hostname to route, with the origin the edge should dial. */
export interface AppRoute {
    /** Stable id (the Domain row id) used to name the router/service. */
    readonly id: string;
    readonly hostname: string;
    /** "le" (Let's Encrypt), "none" (plain HTTP, TLS handled upstream), or the
     *  edge's default cert for anything else (a LAN/internal name). */
    readonly certResolver: string;
    /** Host the edge dials for this app's published port. */
    readonly dialHost: string;
    readonly dialPort: number;
    /** WAF IP allowlists (one per configured scope). A request must satisfy every
     *  list, so each becomes a chained `ipAllowList` middleware. Empty/omitted =
     *  no allowlist restriction. */
    readonly allowLists?: readonly (readonly string[])[];
    /** WAF denylist / custom rules / require-login: when any is set, the route gets
     *  the header + forwardAuth guard middlewares carrying this rule to the edge
     *  guard. */
    readonly deny?: readonly string[];
    /** Managed rule-pack ids, expanded by the guard rather than sent expanded. */
    readonly presets?: readonly string[];
    readonly rules?: readonly WafCustomRule[];
    readonly requireLogin?: boolean;
    /** Where the guard sends a visitor to sign in - the address Polaris is reachable at
     *  from wherever the visitor is, which is a setting rather than something either
     *  edge can work out for itself. */
    readonly loginUrl?: string;
    /** One principal list per scope that named who its login admits; a visitor must
     *  satisfy every one. Empty means any account, so it changes nothing on its own. */
    readonly loginAllowLists?: readonly (readonly WafPrincipalGrant[])[];
    /** Principals refused whatever admits them, unioned across scopes. */
    readonly loginDeny?: readonly WafPrincipalGrant[];
    /** Refuse requests whose headers do not hold together as a browser's. Needs the
     *  guard, like the denylist and the custom rules. */
    readonly browserIntegrity?: boolean;
    /** Refuse requests whose URL carries a SQL injection payload, and the same for a
     *  cross-site scripting one. Both need the guard, and both are on by default - so
     *  in practice they are what puts the guard in front of a route that has no other
     *  rule on it. */
    readonly sqlInjectionProtection?: boolean;
    readonly xssProtection?: boolean;
    /** Rewrite email addresses in served HTML. Carried to the guard for completeness
     *  but does NOT on its own put the guard in front of the route: forwardAuth never
     *  sees a response, so this one is applied by the guard's proxy mode instead. */
    readonly emailObfuscation?: boolean;
}

/** An edge that can be told the full set of app routes it should serve. */
export interface Router {
    /** Replace this edge's app routes with exactly `routes` (idempotent). */
    sync(routes: readonly AppRoute[]): Promise<void>;
}

/** Base URL of the co-located edge guard Traefik forwards auth checks to. */
function guardUrl(): string {
    return process.env.POLARIS_EDGE_GUARD_URL ?? "http://polaris-edge-guard:8080";
}

/** True if this route needs the forwardAuth guard (has a denylist, custom rules, or
 *  requires login). An allowlist alone does not: Traefik enforces that natively. */
function needsGuard(route: AppRoute): boolean {
    return (
        (route.deny?.length ?? 0) > 0 ||
        (route.presets?.length ?? 0) > 0 ||
        (route.rules?.length ?? 0) > 0 ||
        route.requireLogin === true ||
        route.browserIntegrity === true ||
        route.sqlInjectionProtection === true ||
        route.xssProtection === true
    );
}

/** Base URL of the guard's proxy listener, which is the upstream for a route whose
 *  response gets rewritten. Same container as the forwardAuth guard, second port. */
function guardProxyUrl(): string {
    return process.env.POLARIS_EDGE_PROXY_URL ?? "http://polaris-edge-guard:8081";
}

/** How long a reachability answer is reused for. A sync runs on every deploy, domain
 *  change and firewall edit, and the answer only changes when the sidecar restarts. */
const PROXY_PROBE_TTL_MS = 30_000;
const PROXY_PROBE_TIMEOUT_MS = 2000;

let proxyProbe: { at: number; reachable: boolean } | null = null;

/**
 * Whether the guard's proxy listener is actually answering.
 *
 * Asked before a route is pointed at it, because the guard is a separate container on
 * its own release cadence: one older than the control plane has the forwardAuth server
 * and not the proxy, and writing an upstream nothing listens on turns every obfuscated
 * route into a 502 with a healthy app behind it. The alternative - assume it is there -
 * is what took `orphion.plr.fjrg2007.com` down while its container served fine on the
 * host port.
 *
 * `/health` is the proxy's own endpoint and needs no signed origin, so a 200 means the
 * listener is up AND is this proxy rather than something else that grabbed the port.
 */
export async function guardProxyReachable(now: number = Date.now()): Promise<boolean> {
    if (proxyProbe && now - proxyProbe.at < PROXY_PROBE_TTL_MS) return proxyProbe.reachable;
    let reachable = false;
    try {
        const response = await fetch(`${guardProxyUrl()}/health`, {
            signal: AbortSignal.timeout(PROXY_PROBE_TIMEOUT_MS)
        });
        reachable = response.ok;
    } catch {
        reachable = false;
    }
    proxyProbe = { at: now, reachable };
    return reachable;
}

/** Options a render needs that it cannot work out on its own (they take IO). */
export interface RenderOptions {
    /** Whether the guard's proxy listener is answering. False routes every obfuscated
     *  route direct instead, unobfuscated but serving. */
    readonly proxyAvailable?: boolean;
}

/**
 * Whether this route's response is served through the guard rather than straight from
 * the app.
 *
 * Only email obfuscation needs it, and only when there is a secret to sign the upstream
 * with and a proxy listening to receive it. Either missing means the guard could not
 * serve the request even if we pointed at it, so the route goes direct and simply does
 * not get obfuscated - losing a cosmetic rewrite is the right failure here, taking the
 * route down is not.
 */
function proxied(route: AppRoute, options: RenderOptions): boolean {
    return (
        route.emailObfuscation === true &&
        (process.env.POLARIS_AUTH_SECRET ?? "") !== "" &&
        options.proxyAvailable !== false
    );
}

/** The middleware names to attach to a route's primary (app-serving) router, adding
 *  any middleware definitions they introduce to `defs`. */
function routeMiddlewares(
    route: AppRoute,
    name: string,
    defs: Map<string, string>,
    options: RenderOptions
): string[] {
    const names: string[] = [];
    (route.allowLists ?? []).forEach((allow, index) => {
        if (allow.length === 0) return;
        const mw = `${name}-allow-${index}`;
        const ranges = allow.map((entry) => `"${entry}"`).join(", ");
        defs.set(mw, `    ${mw}:\n      ipAllowList:\n        sourceRange: [${ranges}]`);
        names.push(mw);
    });
    // The rule header is stamped whenever the guard will read it - either because
    // forwardAuth is about to ask it a question, or because the guard IS the upstream
    // and needs to know what to do to the response.
    const isProxied = proxied(route, options);
    if (needsGuard(route) || isProxied) {
        const ctx = `${name}-waf-ctx`;
        const rule = encodeGuardRule({
            deny: route.deny ?? [],
            requireLogin: route.requireLogin === true,
            loginUrl: route.loginUrl,
            loginAllowLists: route.loginAllowLists ?? [],
            loginDeny: route.loginDeny ?? [],
            browserIntegrity: route.browserIntegrity === true,
            sqlInjectionProtection: route.sqlInjectionProtection === true,
            xssProtection: route.xssProtection === true,
            emailObfuscation: route.emailObfuscation === true,
            presets: route.presets ?? [],
            rules: route.rules ?? []
        });
        defs.set(
            ctx,
            `    ${ctx}:\n      headers:\n        customRequestHeaders:\n          X-Polaris-Waf: "${rule}"`
        );
        names.push(ctx);
        // A proxied route gets no forwardAuth: the proxy runs the same decision on the
        // same rule inline, so asking the guard a second time per request would be the
        // same answer for twice the work.
        if (needsGuard(route) && !isProxied) {
            defs.set(
                "polaris-waf-guard",
                `    polaris-waf-guard:\n      forwardAuth:\n        address: "${guardUrl()}/authz"`
            );
            names.push("polaris-waf-guard");
        }
    }
    if (isProxied) {
        // Where the guard should forward to, signed so a client cannot point it
        // somewhere else. Traefik overwrites whatever value the client sent.
        const upstream = `${name}-origin`;
        const signed = signEdgeOrigin(
            `http://${route.dialHost}:${route.dialPort}`,
            process.env.POLARIS_AUTH_SECRET ?? ""
        );
        defs.set(
            upstream,
            `    ${upstream}:\n      headers:\n        customRequestHeaders:\n          X-Polaris-Origin: "${signed}"`
        );
        names.push(upstream);
    }
    return names;
}

/** Render Traefik dynamic config for a set of app routes. Shared by every Router
 *  implementation so local and remote edges serve byte-identical config. */
export function renderDynamicConfig(routes: readonly AppRoute[], options: RenderOptions = {}): string {
    const routers: string[] = [];
    const services: string[] = [];
    const defs = new Map<string, string>([
        ["polaris-redirect-https", "    polaris-redirect-https:\n      redirectScheme:\n        scheme: https"]
    ]);
    for (const route of routes) {
        const name = `polaris-app-${route.id}`;
        const dial = `${route.dialHost}:${route.dialPort}`;
        const appMw = routeMiddlewares(route, name, defs, options);
        const appMwLine = appMw.length > 0 ? `\n      middlewares: [${appMw.join(", ")}]` : "";
        if (route.certResolver === "none") {
            routers.push(
                `    ${name}:\n      rule: "Host(\`${route.hostname}\`)"\n      entryPoints: [web]\n      service: ${name}${appMwLine}`
            );
        } else {
            const tls = route.certResolver === "le" ? "\n      tls:\n        certResolver: letsencrypt" : "\n      tls: {}";
            routers.push(
                `    ${name}:\n      rule: "Host(\`${route.hostname}\`)"\n      entryPoints: [websecure]\n      service: ${name}${appMwLine}${tls}`
            );
            // The http router redirects to https; the allowlist still applies here, but
            // the guard runs only on the canonical https URL (redirect goes first).
            const httpMw = [
                ...appMw.filter((m) => m !== "polaris-waf-guard" && !m.endsWith("-waf-ctx")),
                "polaris-redirect-https"
            ];
            routers.push(
                `    ${name}-http:\n      rule: "Host(\`${route.hostname}\`)"\n      entryPoints: [web]\n      service: ${name}\n      middlewares: [${httpMw.join(", ")}]`
            );
        }
        // A proxied route dials the guard instead of the app; the app's own address
        // travels in the signed header above, so the guard is the only thing that
        // learns it.
        const upstream = proxied(route, options) ? guardProxyUrl() : `http://${dial}`;
        services.push(`    ${name}:\n      loadBalancer:\n        servers:\n          - url: "${upstream}"`);
    }
    if (routers.length === 0) return "http: {}\n";
    const middlewares = [...defs.values()].join("\n");
    return `http:\n  routers:\n${routers.join("\n")}\n  services:\n${services.join("\n")}\n  middlewares:\n${middlewares}\n`;
}

/** The Polaris host's own edge: writes the Traefik file-provider config it watches. */
export class LocalRouter implements Router {
    private readonly file =
        `${process.env.POLARIS_TRAEFIK_DYNAMIC_DIR ?? "/dynamic"}/polaris-apps.yml`;

    public async sync(routes: readonly AppRoute[]): Promise<void> {
        // Only worth asking when something would actually be pointed at the proxy.
        const wantsProxy = routes.some((route) => route.emailObfuscation === true);
        const proxyAvailable = wantsProxy ? await guardProxyReachable() : true;
        if (wantsProxy && !proxyAvailable) {
            const affected = routes.filter((route) => route.emailObfuscation === true).length;
            console.warn(
                `polaris: the edge guard's proxy is not answering on ${guardProxyUrl()}; routing ${affected} domain(s) direct, without email obfuscation. Update the polaris-edge-guard container to restore it.`
            );
        }
        await writeFile(this.file, renderDynamicConfig(routes, { proxyAvailable }), "utf8");
    }
}
