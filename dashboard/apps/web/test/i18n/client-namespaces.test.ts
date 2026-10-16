/**
 * Every namespace a client screen translates with reaches the browser.
 *
 * `useTranslations("ns")` in a client component reads only what a `<Messages
 * namespaces={[...]}>` above it handed down; a namespace nobody handed down is
 * not an error anywhere, it is the key itself printed on the screen. That is how
 * Agent rollouts and the Deploy registries shipped reading
 * "agentRollouts.rollout.heading": the catalogs had every string, and no route
 * gave them to the page.
 *
 * So for each file under `src/app` and `src/components`, the namespaces it uses
 * must be provided on every route that renders it: by the root layout, the app
 * shell, or a `<Messages>` on that route or an ancestor of it. A route file
 * (page, layout, ...) renders on its own folder; any other file renders wherever
 * the files importing it do, followed back through the imports.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const WEB = resolve(__dirname, "../..");
const SRC = join(WEB, "src");
const APP = join(SRC, "app");
const SHELL_ROUTE = join(APP, "(app)");

/** What the root layout and the app shell (`components/app-chrome.tsx`) give
 *  every screen. */
const ROOT = ["common", "components"];
const SHELL = ["nav", "chat", "shortcuts", "tours"];

const ROUTE_FILE = /^(page|layout|template|loading|error|not-found|default|global-error)\.tsx?$/;

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return files(path);
        return /\.tsx?$/.test(entry) ? [path] : [];
    });
}

function provided(source: string): string[] {
    return [...source.matchAll(/namespaces=\{\[([^\]]*)\]\}/g)].flatMap((match) =>
        [...match[1]!.matchAll(/"([^"]+)"/g)].map((name) => name[1]!)
    );
}

/** Imports that can draw something: a component, a hook, a default or a
 *  whole-module import, a re-export, or a dynamic import. A plain helper or a
 *  type pulled out of a screen's file does not render that screen's words. */
function renderedImports(source: string): string[] {
    const found: string[] = [];
    for (const match of source.matchAll(/^\s*import\s+(type\s+)?([^"';]*?)\s*from\s*"([^"]+)"/gm)) {
        if (match[1]) continue;
        const clause = match[2]!;
        const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
        const outside = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
        const draws = named
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part && !part.startsWith("type "))
            .some((part) => /^([A-Z]|use[A-Z])/.test(part.split(/\s+as\s+/)[0]!));
        if (outside || draws) found.push(match[3]!);
    }
    for (const match of source.matchAll(/^\s*export\s+(?!type\b)[^"';]*?\s*from\s*"([^"]+)"/gm)) {
        found.push(match[1]!);
    }
    for (const match of source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) found.push(match[1]!);
    return found;
}

function code(source: string): string {
    return source.replace(/^\s*(\/\/|\/\*|\*).*$/gm, "");
}

function used(source: string): string[] {
    const names = [...source.matchAll(/useTranslations\(\s*"([^"]+)"/g)].map(
        (match) => match[1]!.split(".")[0]!
    );
    return [...new Set(names)];
}

function resolveImport(from: string, specifier: string): string | undefined {
    const base = specifier.startsWith("@/")
        ? join(SRC, specifier.slice(2))
        : specifier.startsWith(".")
          ? resolve(dirname(from), specifier)
          : undefined;
    if (!base) return undefined;
    const candidates = [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")];
    return candidates.find((path) => existsSync(path) && statSync(path).isFile());
}

function within(dir: string, ancestor: string): boolean {
    return dir === ancestor || dir.startsWith(ancestor + sep);
}

describe("client translation namespaces", () => {
    it("are handed down on every route that uses them", () => {
        const all = files(SRC);
        const sources = new Map(all.map((path) => [path, code(readFileSync(path, "utf8"))]));

        const imports = new Map<string, string[]>();
        for (const [path, source] of sources) {
            const targets = renderedImports(source).map((specifier) => resolveImport(path, specifier));
            imports.set(path, targets.filter((target): target is string => !!target && target !== path));
        }

        const isRoute = (path: string) => within(path, APP) && ROUTE_FILE.test(basename(path));
        const rendersOn = new Map<string, Set<string>>();
        for (const route of all.filter(isRoute)) {
            const seen = new Set<string>();
            const stack = [route];
            while (stack.length > 0) {
                const path = stack.pop()!;
                if (seen.has(path)) continue;
                seen.add(path);
                if (!rendersOn.has(path)) rendersOn.set(path, new Set());
                rendersOn.get(path)!.add(dirname(route));
                for (const target of imports.get(path) ?? []) if (!isRoute(target)) stack.push(target);
            }
        }
        const routes = (path: string): string[] => {
            const found = rendersOn.get(path);
            if (found) return [...found];
            return within(path, APP) ? [dirname(path)] : [];
        };

        const providers = [...sources]
            .map(([path, source]) => ({ routes: routes(path), names: provided(source) }))
            .filter((entry) => entry.names.length > 0);

        const missing = all
            .filter((path) => within(path, APP) || within(path, join(SRC, "components")))
            .flatMap((path) => {
                const namespaces = used(sources.get(path)!);
                if (namespaces.length === 0) return [];
                const name = relative(WEB, path).split(sep).join("/");
                return routes(path).flatMap((route) => {
                    const have = new Set([...ROOT, ...(within(route, SHELL_ROUTE) ? SHELL : [])]);
                    for (const entry of providers) {
                        if (!entry.routes.some((dir) => within(route, dir))) continue;
                        entry.names.forEach((namespace) => have.add(namespace));
                    }
                    const where = relative(APP, route).split(sep).join("/") || "/";
                    return namespaces
                        .filter((namespace) => !have.has(namespace))
                        .map((namespace) => `${name} on ${where}: ${namespace}`);
                });
            });

        expect(missing).toEqual([]);
    });
});
