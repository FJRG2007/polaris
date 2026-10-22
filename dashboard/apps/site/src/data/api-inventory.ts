/**
 * Every HTTP route in the dashboard's apps that answers to an API key, found
 * from the code on each build so a new route is in the reference with no docs
 * work.
 *
 * The rule, written once: a route is public API when its file calls
 * `authenticateApiKey` / `requireApiKey`, or imports a module that does. Every
 * other route is the interface's own (a signed-in browser) and is left out.
 * Shapes come from the OpenAPI document where it describes the route; a route
 * it does not describe is listed with its method and path only.
 */

import type { ApiOperation } from "@/data/builders";

export interface RouteSource {
    /** The app's source folder name ("web"), for the `@/` alias. */
    readonly app: string;
    /** The file path relative to the app's `src/app`, with forward slashes. */
    readonly file: string;
    readonly source: string;
}

export interface ModuleSource {
    readonly app: string;
    /** The import specifier that reaches it, e.g. `@/lib/deck/auth`. */
    readonly specifier: string;
    readonly source: string;
}

export interface InventoryRoute {
    readonly method: string;
    readonly path: string;
    readonly group: string;
    /** The documented operation, when the OpenAPI document has this one. */
    readonly operation: ApiOperation | null;
}

const KEY_AUTH = /\b(authenticateApiKey|requireApiKey)\s*\(/;
const METHOD_EXPORT =
    /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b|export\s*\{[^}]*\b(GET|POST|PUT|PATCH|DELETE)\b/g;

/** `api/v1/projects/[id]/route.ts` as `/api/v1/projects/{id}`. */
export function routePath(file: string): string {
    const segments = file
        .replace(/\/route\.tsx?$/, "")
        .split("/")
        .filter((segment) => !/^\(.*\)$/.test(segment))
        .map((segment) => segment.replace(/^\[\[?(?:\.\.\.)?([^\]]+)\]?\]$/, "{$1}"));
    return `/${segments.join("/")}`;
}

/** The section a path belongs to: its first segment after `/api` (and `/v1`). */
export function routeGroup(path: string): string {
    const parts = path.split("/").filter(Boolean);
    const rest = parts[0] === "api" ? parts.slice(1) : parts;
    const group = rest[0] === "v1" ? rest[1] : rest[0];
    return group && !group.startsWith("{") ? group : "other";
}

export function routeMethods(source: string): string[] {
    const found = new Set<string>();
    for (const match of source.matchAll(METHOD_EXPORT)) {
        const method = match[1] ?? match[2];
        if (method) found.add(method);
    }
    return [...found];
}

/** The specifiers a module imports. */
function imports(source: string): string[] {
    return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

export function apiInventory(
    routes: readonly RouteSource[],
    modules: readonly ModuleSource[],
    documented: readonly ApiOperation[]
): { routes: InventoryRoute[]; internal: number } {
    const authModules = new Set(
        modules.filter((m) => KEY_AUTH.test(m.source)).map((m) => `${m.app}:${m.specifier}`)
    );
    const byKey = new Map(documented.map((op) => [`${op.method} ${op.path}`, op]));
    const out: InventoryRoute[] = [];
    let internal = 0;
    for (const route of routes) {
        const reachable =
            KEY_AUTH.test(route.source) ||
            imports(route.source).some((spec) => authModules.has(`${route.app}:${spec}`));
        const methods = routeMethods(route.source);
        if (!reachable) {
            internal += methods.length;
            continue;
        }
        const path = routePath(route.file);
        for (const method of methods)
            out.push({
                method,
                path,
                group: routeGroup(path),
                operation: byKey.get(`${method} ${path}`) ?? null
            });
    }
    out.sort((a, b) => a.group.localeCompare(b.group) || a.path.localeCompare(b.path));
    return { routes: out, internal };
}
