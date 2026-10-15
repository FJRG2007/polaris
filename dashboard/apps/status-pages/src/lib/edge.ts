/**
 * A status page at the operator's own hostname.
 *
 * Each published page with a custom domain gets a router to the dashboard,
 * written as the app's own edge file (`polaris-app-status-pages.yml`) through
 * the host, which writes it atomically. The root of that hostname is rewritten
 * to the page's public path; the rest passes through, so the page's scripts and
 * styles load as they do on the dashboard's own names.
 *
 * Priority 50, the band the dashboard's own public hostnames use (see the edge
 * section of CLAUDE.md): below the host-less path routers at 100, above the
 * compose catch-all at 10. The certificate comes from the same resolver.
 *
 * `renderStatusEdge` is pure, so the YAML is asserted in a test; the sync reads
 * the pages and writes the whole file every time, so a removed domain, an
 * unpublished page or a deleted one simply is not in it.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { SLUG_PATTERN, isCustomHostname } from "../model/schemas";

const APP_ID = "status-pages";
const PRIORITY = 50;
const SERVICE = "polaris-status-pages";
const REDIRECT = `${SERVICE}-redirect-https`;

export interface StatusEdgeRoute {
    readonly hostname: string;
    readonly slug: string;
}

/** The edge file for these routes. Anything that is not a valid hostname and
 *  slug is left out, so nothing typed can reach the YAML unchecked. */
export function renderStatusEdge(routes: readonly StatusEdgeRoute[], origin: string): string {
    const valid = routes
        .filter((route) => isCustomHostname(route.hostname) && SLUG_PATTERN.test(route.slug))
        .sort((a, b) => a.hostname.localeCompare(b.hostname));
    const unique = valid.filter(
        (route, index) => valid.findIndex((other) => other.hostname === route.hostname) === index
    );
    if (unique.length === 0) return "http: {}\n";

    const routers: string[] = [];
    const middlewares: string[] = [
        `    ${REDIRECT}:`,
        "      redirectScheme:",
        "        scheme: https"
    ];
    for (const route of unique) {
        const name = `${SERVICE}-${route.slug}`;
        const root = `${name}-root`;
        const rule = `Host(\`${route.hostname}\`)`;
        routers.push(
            `    ${name}:`,
            `      rule: "${rule}"`,
            "      entryPoints: [websecure]",
            `      priority: ${PRIORITY}`,
            `      service: ${SERVICE}`,
            `      middlewares: [${root}]`,
            "      tls:",
            "        certResolver: letsencrypt",
            `    ${name}-http:`,
            `      rule: "${rule}"`,
            "      entryPoints: [web]",
            `      priority: ${PRIORITY}`,
            `      service: ${SERVICE}`,
            `      middlewares: [${REDIRECT}]`
        );
        middlewares.push(
            `    ${root}:`,
            "      replacePathRegex:",
            '        regex: "^/$"',
            `        replacement: "/status/${route.slug}"`
        );
    }
    return [
        "http:",
        "  routers:",
        ...routers,
        "  services:",
        `    ${SERVICE}:`,
        "      loadBalancer:",
        "        servers:",
        `          - url: "${origin}"`,
        "  middlewares:",
        ...middlewares,
        ""
    ].join("\n");
}

/** The routes the pages call for now: published pages with a domain. */
export async function statusEdgeRoutes(): Promise<StatusEdgeRoute[]> {
    const pages = await prisma.statusPage.findMany({
        where: { published: true, customDomain: { not: null } },
        orderBy: { createdAt: "asc" },
        take: 500,
        select: { slug: true, customDomain: true }
    });
    return pages.map((page) => ({ hostname: page.customDomain!, slug: page.slug }));
}

/** Rewrites the app's edge file from the pages. Throws when it cannot write. */
export async function syncStatusEdge(): Promise<void> {
    const [routes, origin] = await Promise.all([statusEdgeRoutes(), host.appEdge.appEdgeOrigin()]);
    await host.appEdge.writeAppEdge(APP_ID, renderStatusEdge(routes, origin));
}

/** The same, for callers that must not fail on it: a page saves either way,
 *  and the next save, boot or hourly pass writes the file again. */
export async function trySyncStatusEdge(): Promise<boolean> {
    try {
        await syncStatusEdge();
        return true;
    } catch (caught) {
        console.error("polaris: status page routes not written:", (caught as Error).message);
        return false;
    }
}
