/**
 * How the README scenes are bundled: the dashboard's own client components, with
 * everything that only exists on a server replaced at bundle time. Shared by the
 * build, which bundles the page the pictures are taken of, and by the test,
 * which bundles the scene list on its own to check the definitions.
 *
 * - a module that starts with "use server" becomes one function per export that
 *   asks the scene for its answer (`globalThis.__ACTIONS__`), so a screen that
 *   loads through server actions gets fixture data and never a network call;
 * - server-only packages (database, auth, SSH, Docker, the host daemon) and
 *   Node's built-ins become empty modules, because a client component only
 *   reaches them through types or through code it never runs in the browser;
 * - `next/*` becomes a few lines that behave like it in a page with no router.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { builtinModules, createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const web = join(root, "apps", "web");
const require = createRequire(join(root, "package.json"));
const esbuild = await import(pathToFileURL(require.resolve("esbuild")).href);

/** Packages that only run on a server. A client component imports them for a
 *  type or a constant at most, and neither survives to the browser. */
const SERVER_PACKAGES = [
    "@polaris/db",
    "@polaris/auth",
    "@polaris/storage",
    "@polaris/ssh",
    "@polaris/deploy",
    "@polaris/docker",
    "@polaris/messaging",
    "@polaris/hostd-client",
    "@polaris/config",
    "@polaris/agent-runtime",
    "@prisma/client",
    "@opentelemetry/api",
    "server-only",
    "nodemailer",
    "imapflow",
    "ioredis",
    "pg",
    "mysql2",
    "mongodb",
    "ssh2",
    "dockerode"
];

/** `@/lib` modules that are server-side by name: services, the session, the
 *  database handle and the settings store. */
const SERVER_LIB = /^@\/lib\/(.*-service|session|setting-store|prisma|mail|i18n\/request)$/;

const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

function isServerPackage(path) {
    return SERVER_PACKAGES.some((name) => path === name || path.startsWith(`${name}/`));
}

/** The file an `@/` or relative import names, or null when it is not ours. */
function sourceFile(path, importer) {
    const base = path.startsWith("@/") ? join(web, "src", path.slice(2)) : resolve(dirname(importer), path);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
        if (existsSync(candidate) && !candidate.endsWith("/") && /\.(ts|tsx)$/.test(candidate)) return candidate;
    }
    return null;
}

const USE_SERVER = /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["']/;
const EXPORTED = /export\s+(?:async\s+)?(?:function\*?|const|let)\s+([A-Za-z_$][\w$]*)/g;

/** One dispatcher per exported action, answered by the running scene. */
function actionStub(file) {
    const names = new Set();
    for (const match of readFileSync(file, "utf8").matchAll(EXPORTED)) names.add(match[1]);
    const lines = ['import { dispatch } from "@readme-media/actions";'];
    for (const name of names) lines.push(`export const ${name} = dispatch(${JSON.stringify(name)});`);
    return lines.join("\n");
}

const stubs = {
    name: "readme-media-stubs",
    setup(build) {
        build.onResolve({ filter: /^@readme-media\// }, (args) => ({
            path: join(here, "runtime", `${args.path.slice("@readme-media/".length)}.tsx`)
        }));
        build.onResolve({ filter: /^next\// }, (args) => ({
            path: join(here, "runtime", "next", `${args.path.slice(5).replace(/\//g, "-")}.tsx`)
        }));
        // A stylesheet's url("/x") points at the app's public folder, which the
        // page serves as it is.
        build.onResolve({ filter: /^\// }, (args) => (args.kind === "url-token" ? { path: args.path, external: true } : undefined));
        build.onResolve({ filter: /.*/ }, (args) => {
            if (args.importer.includes("node_modules")) {
                if (builtins.has(args.path)) return { path: args.path, namespace: "empty" };
                return undefined;
            }
            if (builtins.has(args.path) || isServerPackage(args.path) || SERVER_LIB.test(args.path)) {
                return { path: args.path, namespace: "empty" };
            }
            if (args.path.startsWith("@/") || args.path.startsWith(".")) {
                const file = sourceFile(args.path, args.importer);
                if (file && USE_SERVER.test(readFileSync(file, "utf8").slice(0, 400))) {
                    return { path: file, namespace: "action" };
                }
            }
            return undefined;
        });
        build.onLoad({ filter: /.*/, namespace: "empty" }, (args) => ({
            // CJS so any named import off it links. `crypto` keeps what the
            // browser has, because something calls it at module scope.
            contents:
                args.path === "crypto" || args.path === "node:crypto"
                    ? "module.exports = { randomUUID: () => globalThis.crypto.randomUUID(), randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)), createHash: () => ({ update() { return this; }, digest: () => '' }) };"
                    : "module.exports = {};",
            loader: "js"
        }));
        build.onLoad({ filter: /.*/, namespace: "action" }, (args) => ({
            contents: actionStub(args.path),
            loader: "ts",
            resolveDir: here
        }));
    }
};

/** Bundle `entry` into `outfile` as a browser ES module, with the rules above. */
export function bundle(entry, outfile) {
    return esbuild.build({
        entryPoints: [entry],
        bundle: true,
        outfile,
        format: "esm",
        platform: "browser",
        target: "es2022",
        jsx: "automatic",
        minify: false,
        sourcemap: false,
        logLevel: "warning",
        absWorkingDir: root,
        nodePaths: [join(root, "node_modules"), join(web, "node_modules")],
        tsconfig: join(web, "tsconfig.json"),
        define: {
            "process.env.NODE_ENV": '"production"',
            "process.env": "__READMEMEDIA_ENV__",
            "process.platform": '"browser"'
        },
        loader: { ".svg": "dataurl", ".png": "dataurl", ".gif": "dataurl", ".jpg": "dataurl", ".webp": "dataurl", ".woff2": "file", ".woff": "file", ".ttf": "file", ".eot": "file", ".otf": "file", ".wasm": "file", ".mp3": "file", ".ogg": "file", ".wav": "file", ".mp4": "file", ".webm": "file" },
        plugins: [stubs],
        metafile: true
    });
}
