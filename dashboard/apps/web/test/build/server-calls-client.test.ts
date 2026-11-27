/**
 * The line between server and client modules, both ways.
 *
 * A page, layout or route never calls a function out of a "use client" file.
 *
 * On the server every export of a client module is a reference, not the
 * function, so calling one throws "Attempted to call x() from the server" and
 * the whole route renders as an error. That is how Analytics went down: its page
 * checked `?tab=` with a helper that lived in the reports component. Rendering a
 * client component is fine - only a call is not - so what is looked for is a
 * lower-case import from a client module used as `name(`.
 *
 * And a client module never reaches the database or Node's own modules, however
 * many imports away. Webpack bundles everything a client file imports for the
 * browser, so one value import of a server module pulls `@polaris/db` - and the
 * Prisma client's `fs` and `child_process` - into it, and `next build` stops
 * with "Can't resolve 'fs'". Type-only imports are erased and a "use server"
 * file is only a reference on the client, so the walk stops at both. tsc and
 * vitest pass either way, which is how every dashboard image failed for a day
 * on a Usage page that took its range list from the report's queries.
 */

import { describe, expect, it } from "vitest";
import { dirname, join, relative, resolve } from "node:path";
import { builtinModules } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const APPS = resolve(__dirname, "../../..");
const WEB_SRC = join(APPS, "web/src");
const ROOTS = ["web/src/app", "game-servers/src", "places/src"].map((root) => join(APPS, root));

/** What renders or runs on the server by itself: Next's entry files. */
const ENTRY = /^(page|layout|template|default|not-found|route)\.tsx?$/;
const sources = new Map<string, string>();
function read(path: string): string {
    let source = sources.get(path);
    if (source === undefined) sources.set(path, (source = readFileSync(path, "utf8")));
    return source;
}

/** Whether a file opens with "use client", once its leading comments are skipped. */
function isClient(source: string): boolean {
    let rest = source.trimStart();
    for (;;) {
        if (rest.startsWith("/*")) rest = rest.slice(rest.indexOf("*/") + 2).trimStart();
        else if (rest.startsWith("//")) rest = rest.slice(rest.indexOf("\n") + 1).trimStart();
        else break;
    }
    return /^["']use client["']/.test(rest);
}
const IMPORT = /import\s+(?!type\b)\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : files(path);
        return /\.tsx?$/.test(entry) ? [path] : [];
    });
}

function resolveImport(from: string, spec: string): string | null {
    const base = spec.startsWith("@/")
        ? join(WEB_SRC, spec.slice(2))
        : spec.startsWith(".")
          ? resolve(dirname(from), spec)
          : null;
    if (!base) return null;
    for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        const path = base + suffix;
        if (existsSync(path) && statSync(path).isFile()) return path;
    }
    return null;
}

function callsIntoClient(path: string): string[] {
    const source = read(path);
    if (isClient(source)) return [];
    const found: string[] = [];
    for (const match of source.matchAll(IMPORT)) {
        const target = resolveImport(path, match[2] ?? "");
        if (!target || !isClient(read(target))) continue;
        for (const raw of (match[1] ?? "").split(",")) {
            const name = raw.trim();
            if (!name || name.startsWith("type ")) continue;
            const local = name.split(/\s+as\s+/).pop()?.trim() ?? "";
            if (!/^[a-z]/.test(local)) continue;
            const call = new RegExp(`(?<![\\w.<])${local}\\s*\\(`);
            if (call.test(source.slice((match.index ?? 0) + match[0].length)))
                found.push(`${relative(APPS, path).split("\\").join("/")}: ${local}()`);
        }
    }
    return found;
}

describe("server entry files", () => {
    it("are found at all, so this cannot pass by looking at nothing", () => {
        expect(ROOTS.flatMap(files).filter((path) => ENTRY.test(path.split(/[\\/]/).pop() ?? "")).length).toBeGreaterThan(100);
    });

    it("never call a function exported from a client module", () => {
        const offenders = ROOTS.flatMap(files)
            .filter((path) => ENTRY.test(path.split(/[\\/]/).pop() ?? ""))
            .flatMap(callsIntoClient);
        expect(offenders).toEqual([]);
    });
});


/** What only the server can load: the database client, the marker, and Node's own modules. */
const NODE = new Set(builtinModules);
const SERVER_ONLY = (spec: string) =>
    spec === "@polaris/db" || spec.startsWith("@polaris/db/") || spec === "server-only" || spec.startsWith("node:") || NODE.has(spec);

const isServerAction = (source: string) => /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*["']use server["']/.test(source);

/** Every specifier a module loads at run time: type-only imports and exports, and `import("x").T` in a type, are erased. */
const VALUE_IMPORT =
    /(?:^|[\n;])\s*(?:import|export)\s+(?!type\s)((?:[\w$*\s,]|\{[^}]*\})*?)\s*from\s*["']([^"']+)["']|(?:^|[\n;])\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)(?!\.(?!then\b|catch\b|finally\b)[A-Za-z_$])/g;

/** A template literal's text is not code: a script Polaris writes out for a machine can import `node:readline`. */
const TEMPLATE = /`(?:\\[\s\S]|[^`\\])*`/g;
function valueImports(source: string): string[] {
    const specs: string[] = [];
    for (const match of source.replace(TEMPLATE, "``").matchAll(VALUE_IMPORT)) {
        const clause = match[1];
        if (clause !== undefined) {
            const braces = /^\{([^}]*)\}$/.exec(clause.trim());
            const names = braces ? (braces[1] ?? "").split(",").map((name) => name.trim()).filter(Boolean) : null;
            if (names && names.length > 0 && names.every((name) => name.startsWith("type "))) continue;
        }
        const spec = match[2] ?? match[3] ?? match[4];
        if (spec) specs.push(spec);
    }
    return specs;
}

const rel = (path: string) => relative(APPS, path).split("\\").join("/");

/** Each module's run-time imports, read once: the server-only ones by name, the rest as files. */
const edges = new Map<string, { server: string | null; files: string[] }>();
function edgesOf(path: string): { server: string | null; files: string[] } {
    let found = edges.get(path);
    if (found) return found;
    const specs = valueImports(read(path));
    const resolved = specs.flatMap((spec) => {
        const target = resolveImport(path, spec);
        return target && !isServerAction(read(target)) ? [target] : [];
    });
    edges.set(path, (found = { server: specs.find(SERVER_ONLY) ?? null, files: resolved }));
    return found;
}

/** The first chain from a client file to a server-only module, or null. */
function serverChain(entry: string): string[] | null {
    const seen = new Set([entry]);
    const queue: string[][] = [[entry]];
    while (queue.length > 0) {
        const chain = queue.shift() ?? [];
        const path = chain[chain.length - 1] ?? "";
        const { server, files: next } = edgesOf(path);
        if (server) return [...chain.map(rel), server];
        for (const target of next) {
            if (seen.has(target)) continue;
            seen.add(target);
            queue.push([...chain, target]);
        }
    }
    return null;
}

describe("client modules", () => {
    const clients = [WEB_SRC, ...ROOTS.slice(1)].flatMap(files).filter((path) => isClient(read(path)));

    it("are found at all, so this cannot pass by looking at nothing", () => {
        expect(clients.length).toBeGreaterThan(500);
    });

    it("tell a type-only import from one that loads the module", () => {
        expect(valueImports('import type { A } from "@polaris/db";\nimport { type B, type C } from "fs";\nlet d: import("node:net").Socket;')).toEqual([]);
        expect(valueImports("const s = `import { x } from \"node:fs\"`;")).toEqual([]);
        expect(valueImports('import { type A, b } from "@polaris/db";\nexport * from "./x";\nimport "./y";\nawait import("./z");\nimport("./w").then(go);')).toEqual([
            "@polaris/db",
            "./x",
            "./y",
            "./z",
            "./w"
        ]);
    });

    it("never reach the database or Node's own modules", () => {
        const offenders = clients.flatMap((path) => {
            const chain = serverChain(path);
            return chain ? [chain.join(" -> ")] : [];
        });
        expect(offenders).toEqual([]);
    });
});
