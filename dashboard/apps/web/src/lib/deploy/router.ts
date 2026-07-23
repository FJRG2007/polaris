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
import { encodeGuardRule } from "@polaris/core/waf";

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
    /** WAF denylist / require-login: when either is set, the route gets the header +
     *  forwardAuth guard middlewares carrying this rule to the edge guard. */
    readonly deny?: readonly string[];
    readonly requireLogin?: boolean;
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

/** True if this route needs the forwardAuth guard (has a denylist or requires login). */
function needsGuard(route: AppRoute): boolean {
    return (route.deny?.length ?? 0) > 0 || route.requireLogin === true;
}

/** The middleware names to attach to a route's primary (app-serving) router, adding
 *  any middleware definitions they introduce to `defs`. */
function routeMiddlewares(route: AppRoute, name: string, defs: Map<string, string>): string[] {
    const names: string[] = [];
    (route.allowLists ?? []).forEach((allow, index) => {
        if (allow.length === 0) return;
        const mw = `${name}-allow-${index}`;
        const ranges = allow.map((entry) => `"${entry}"`).join(", ");
        defs.set(mw, `    ${mw}:\n      ipAllowList:\n        sourceRange: [${ranges}]`);
        names.push(mw);
    });
    if (needsGuard(route)) {
        const ctx = `${name}-waf-ctx`;
        const rule = encodeGuardRule({ deny: route.deny ?? [], requireLogin: route.requireLogin === true });
        defs.set(
            ctx,
            `    ${ctx}:\n      headers:\n        customRequestHeaders:\n          X-Polaris-Waf: "${rule}"`
        );
        defs.set(
            "polaris-waf-guard",
            `    polaris-waf-guard:\n      forwardAuth:\n        address: "${guardUrl()}/authz"`
        );
        names.push(ctx, "polaris-waf-guard");
    }
    return names;
}

/** Render Traefik dynamic config for a set of app routes. Shared by every Router
 *  implementation so local and remote edges serve byte-identical config. */
export function renderDynamicConfig(routes: readonly AppRoute[]): string {
    const routers: string[] = [];
    const services: string[] = [];
    const defs = new Map<string, string>([
        ["polaris-redirect-https", "    polaris-redirect-https:\n      redirectScheme:\n        scheme: https"]
    ]);
    for (const route of routes) {
        const name = `polaris-app-${route.id}`;
        const dial = `${route.dialHost}:${route.dialPort}`;
        const appMw = routeMiddlewares(route, name, defs);
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
        services.push(`    ${name}:\n      loadBalancer:\n        servers:\n          - url: "http://${dial}"`);
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
        await writeFile(this.file, renderDynamicConfig(routes), "utf8");
    }
}
