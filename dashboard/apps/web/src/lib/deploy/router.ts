/**
 * Modular edge router. Each connected server has its own edge (Traefik), and this
 * is the seam that writes an edge's dynamic routing config. A `LocalRouter` writes
 * the Polaris host's own edge (the shared `/dynamic` volume the local Traefik
 * watches); a future `RemoteRouter` will push the same config to a remote server's
 * edge over SSH. Keeping the request path on the server that runs the app is what
 * stops the control plane from becoming a single point of failure - see the deploy
 * topology notes.
 */

import { writeFile } from "node:fs/promises";

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
}

/** An edge that can be told the full set of app routes it should serve. */
export interface Router {
    /** Replace this edge's app routes with exactly `routes` (idempotent). */
    sync(routes: readonly AppRoute[]): Promise<void>;
}

/** Render Traefik dynamic config for a set of app routes. Shared by every Router
 *  implementation so local and remote edges serve byte-identical config. */
export function renderDynamicConfig(routes: readonly AppRoute[]): string {
    const routers: string[] = [];
    const services: string[] = [];
    for (const route of routes) {
        const name = `polaris-app-${route.id}`;
        const dial = `${route.dialHost}:${route.dialPort}`;
        if (route.certResolver === "none") {
            routers.push(`    ${name}:\n      rule: "Host(\`${route.hostname}\`)"\n      entryPoints: [web]\n      service: ${name}`);
        } else {
            const tls = route.certResolver === "le" ? "\n      tls:\n        certResolver: letsencrypt" : "\n      tls: {}";
            routers.push(`    ${name}:\n      rule: "Host(\`${route.hostname}\`)"\n      entryPoints: [websecure]\n      service: ${name}${tls}`);
            routers.push(`    ${name}-http:\n      rule: "Host(\`${route.hostname}\`)"\n      entryPoints: [web]\n      service: ${name}\n      middlewares: [polaris-redirect-https]`);
        }
        services.push(`    ${name}:\n      loadBalancer:\n        servers:\n          - url: "http://${dial}"`);
    }
    if (routers.length === 0) return "http: {}\n";
    return `http:\n  routers:\n${routers.join("\n")}\n  services:\n${services.join("\n")}\n  middlewares:\n    polaris-redirect-https:\n      redirectScheme:\n        scheme: https\n`;
}

/** The Polaris host's own edge: writes the Traefik file-provider config it watches. */
export class LocalRouter implements Router {
    private readonly file =
        `${process.env.POLARIS_TRAEFIK_DYNAMIC_DIR ?? "/dynamic"}/polaris-apps.yml`;

    public async sync(routes: readonly AppRoute[]): Promise<void> {
        await writeFile(this.file, renderDynamicConfig(routes), "utf8");
    }
}
