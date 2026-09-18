/**
 * Build an installable app's package into the bundle a dashboard downloads.
 *
 * A bundle is what an app is on a server that installed it: its own code and
 * nothing else. The libraries the dashboard already has - React, Next, zod and
 * every @polaris package - are never inside one. They are left as references
 * the dashboard answers with its own copies when it loads the bundle (see
 * `apps/web/src/lib/app-bundles`), so an app adds its code to memory and not a
 * second React or a second database client.
 *
 * Two halves, built from the same source:
 *
 * - `server/index.cjs`, one CommonJS file the dashboard evaluates in its own
 *   process. Its entry lists the app's extension, its routes (by the path they
 *   answer, which is where they sit under `src/routes`) and its server actions.
 *   Routes and actions are loaded on first use, as they were when Next compiled
 *   them. A `"use client"` module is replaced by references the dashboard
 *   renders with the browser half.
 * - `client/`, ES modules the browser imports, one entry per `"use client"`
 *   module plus the chunks they share. A `"use server"` module is replaced by
 *   calls the dashboard forwards to the server half.
 *
 * The manifest names both, and which shared libraries each half expects.
 *
 *   node packages/app-host/bundler/build.mjs <out-dir> [--build <sha>] [<app-dir>...]
 *
 * Deterministic: the same source and dependencies give the same bytes, so a
 * bundle's digest identifies what was built.
 */

import JSZip from "jszip";
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

/** The libraries a bundle takes from the dashboard instead of carrying. */
export const SHARED = /^(react|react-dom|next|zod|@polaris\/[a-z0-9-]+)(\/.*)?$/;

/** Bumped when the shape of a bundle changes, so a dashboard can refuse one it
 *  does not know how to load. */
export const BUNDLE_FORMAT = 1;

/** A zip's entries carry a date; a fixed one keeps two builds byte-identical. */
const ZIP_DATE = new Date("2000-01-01T00:00:00Z");

const DIRECTIVE = (kind) => new RegExp(`^(?:\\s*(?://[^\\n]*|/\\*[\\s\\S]*?\\*/))*\\s*["']use ${kind}["']`);
const USE_CLIENT = DIRECTIVE("client");
const USE_SERVER = DIRECTIVE("server");

const posix = (path) => path.split(sep).join("/");

function walk(directory, found = []) {
    for (const entry of readdirSync(directory).sort()) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) walk(full, found);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
    }
    return found;
}

/** A module's id inside the bundle: its path under `src`, no extension. */
function moduleId(src, file) {
    return posix(relative(src, file)).replace(/\.tsx?$/, "");
}

/** What an app says about itself, in its package.json under `polaris`. */
function readApp(dir) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const app = pkg.polaris;
    if (!app || typeof app.id !== "string" || typeof app.extension !== "string") {
        throw new Error(`${pkg.name}: package.json has no "polaris" section with an id and an extension`);
    }
    const [extensionFile, extensionExport] = app.extension.split("#");
    return {
        name: pkg.name,
        version: pkg.version,
        id: app.id,
        extensionFile: resolve(dir, extensionFile),
        extensionExport,
        slot: app.slot ? app.slot.split("#") : null,
        prepare: app.prepare ? resolve(dir, app.prepare) : null,
        assets: app.assets ?? {}
    };
}

/**
 * Where a route answers, from where it sits: `routes/places/cameras/page.tsx`
 * is `/places/cameras`, `routes/api/home/[id]/route.ts` is `/api/home/[id]`.
 */
function routePath(routes, file) {
    const path = posix(relative(routes, dirname(file)));
    return `/${path}`.replace(/\/$/, "") || "/";
}

function sharedPlugin(side, used) {
    return {
        name: "polaris-shared",
        setup(build) {
            build.onResolve({ filter: SHARED }, (args) => {
                used.add(args.path);
                return { path: args.path, namespace: "polaris-shared" };
            });
            // A CommonJS module whose exports are the dashboard's copy, looked up
            // when each name is read: the dashboard fills its table in as it
            // starts, and a name read early must still find the real thing.
            build.onLoad({ filter: /.*/, namespace: "polaris-shared" }, (args) => ({
                contents: `module.exports = globalThis[Symbol.for("polaris.app-shared")](${JSON.stringify(side)}, ${JSON.stringify(args.path)});`,
                loader: "js"
            }));
        }
    };
}

/** In the browser half, a server action is a call the dashboard forwards. */
function actionStubPlugin(app, src, actions) {
    return {
        name: "polaris-actions",
        setup(build) {
            build.onLoad({ filter: /\.tsx?$/ }, (args) => {
                const id = actions.get(args.path);
                if (!id) return undefined;
                const names = actions.names.get(args.path);
                const lines = [
                    `const call = globalThis[Symbol.for("polaris.app-action")];`,
                    ...names.map(
                        (name) =>
                            `export const ${name} = (...args) => call(${JSON.stringify(app.id)}, ${JSON.stringify(id)}, ${JSON.stringify(name)}, args);`
                    )
                ];
                return { contents: lines.join("\n"), loader: "js" };
            });
        }
    };
}

/** In the server half, a client component is a reference the dashboard draws. */
function clientRefPlugin(app, clients) {
    return {
        name: "polaris-client-refs",
        setup(build) {
            build.onLoad({ filter: /\.tsx?$/ }, (args) => {
                const entry = clients.get(args.path);
                if (!entry) return undefined;
                const lines = [`const ref = globalThis[Symbol.for("polaris.app-client-ref")];`];
                for (const name of entry.exports) {
                    const value = `ref(${JSON.stringify(app.id)}, ${JSON.stringify(entry.id)}, ${JSON.stringify(name)})`;
                    lines.push(name === "default" ? `export default ${value};` : `export const ${name} = ${value};`);
                }
                return { contents: lines.join("\n"), loader: "js" };
            });
        }
    };
}

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

async function exportsOf(file) {
    const result = await esbuild.build({
        entryPoints: [file],
        bundle: false,
        write: false,
        metafile: true,
        format: "esm",
        outdir: "out",
        jsx: "automatic",
        logLevel: "silent"
    });
    return Object.values(result.metafile.outputs)[0].exports;
}

/** Build one app. Writes `<out>/<id>/...` and `<out>/<id>.zip`, returns the manifest. */
export async function buildAppBundle(dir, out, build = "") {
    const app = readApp(dir);
    // What the app stages for its bundle besides code (its icons, say).
    if (app.prepare) execFileSync(process.execPath, [app.prepare], { cwd: dir, stdio: "inherit" });
    const src = join(dir, "src");
    const routesDir = join(src, "routes");
    const files = walk(src);
    const text = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
    const target = join(out, app.id);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });

    const clientFiles = files.filter((file) => USE_CLIENT.test(text.get(file)));
    const actionFiles = files.filter((file) => USE_SERVER.test(text.get(file)));
    const actions = new Map(actionFiles.map((file) => [file, moduleId(src, file)]));
    actions.names = new Map();
    for (const file of actionFiles) {
        const names = await exportsOf(file);
        if (names.includes("default")) throw new Error(`${moduleId(src, file)}: a server action module has no default export`);
        actions.names.set(file, names);
    }

    // The browser half first: its entries' exports are what the server half's
    // references name.
    const clientShared = new Set();
    const client = await esbuild.build({
        absWorkingDir: dir,
        entryPoints: clientFiles,
        bundle: true,
        splitting: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        jsx: "automatic",
        minify: true,
        outdir: join(target, "client"),
        entryNames: "[name]-[hash]",
        chunkNames: "chunk-[hash]",
        metafile: true,
        legalComments: "none",
        define: { "process.env.NODE_ENV": '"production"' },
        plugins: [sharedPlugin("client", clientShared), actionStubPlugin(app, src, actions)],
        logLevel: "warning"
    });
    const clients = new Map();
    for (const [output, meta] of Object.entries(client.metafile.outputs)) {
        if (!meta.entryPoint) continue;
        const file = resolve(dir, meta.entryPoint);
        clients.set(file, {
            id: moduleId(src, file),
            file: posix(relative(target, resolve(dir, output))),
            exports: meta.exports
        });
    }

    const routes = files
        .filter((file) => file.startsWith(routesDir + sep) && /[/\\](page\.tsx|route\.ts)$/.test(file))
        .map((file) => ({ file, path: routePath(routesDir, file), kind: file.endsWith("page.tsx") ? "page" : "route" }));

    const entry = [
        `export { ${app.extensionExport} as extension } from ${JSON.stringify(app.extensionFile)};`,
        "export const routes = {",
        ...routes.map((route) => `  ${JSON.stringify(`${route.kind} ${route.path}`)}: () => import(${JSON.stringify(route.file)}),`),
        "};",
        "export const actions = {",
        ...actionFiles.map((file) => `  ${JSON.stringify(moduleId(src, file))}: () => import(${JSON.stringify(file)}),`),
        "};"
    ].join("\n");

    const serverShared = new Set();
    const server = await esbuild.build({
        absWorkingDir: dir,
        stdin: { contents: entry, resolveDir: src, sourcefile: "polaris-app-entry.js", loader: "js" },
        bundle: true,
        format: "cjs",
        platform: "node",
        target: "node22",
        jsx: "automatic",
        outfile: join(target, "server", "index.cjs"),
        metafile: true,
        legalComments: "none",
        external: [...NODE_BUILTINS],
        plugins: [sharedPlugin("server", serverShared), clientRefPlugin(app, clients)],
        logLevel: "warning"
    });
    void server;

    // What the app ships besides code, copied as it is.
    const assets = [];
    for (const [name, from] of Object.entries(app.assets)) {
        const source = resolve(dir, from);
        // Something only the image build makes (the login mod's jars need a JDK)
        // is absent from a bundle built anywhere else, and said so.
        if (!existsSync(source)) {
            process.stderr.write(`[app-bundles] ${app.id}: no ${name} at ${source}; built without it\n`);
            continue;
        }
        for (const file of statSync(source).isDirectory() ? walkAll(source) : [source]) {
            const to = posix(join("assets", name, relative(source, file)));
            mkdirSync(dirname(join(target, to)), { recursive: true });
            writeFileSync(join(target, to), readFileSync(file));
            assets.push(to);
        }
    }

    const manifest = {
        format: BUNDLE_FORMAT,
        id: app.id,
        package: app.name,
        version: app.version,
        build,
        server: "server/index.cjs",
        routes: routes.map((route) => `${route.kind} ${route.path}`),
        actions: Object.fromEntries(actionFiles.map((file) => [moduleId(src, file), actions.names.get(file)])),
        client: Object.fromEntries(
            [...clients.values()].map((entry) => [entry.id, { file: entry.file, exports: entry.exports }])
        ),
        shared: { server: [...serverShared].sort(), client: [...clientShared].sort() },
        ...(app.slot ? { slot: { module: moduleId(src, resolve(dir, app.slot[0])), name: app.slot[1] } } : {})
    };
    writeFileSync(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const zip = new JSZip();
    for (const file of walkAll(target).sort()) {
        zip.file(posix(relative(target, file)), readFileSync(file), { date: ZIP_DATE, createFolders: false });
    }
    const bytes = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 9 },
        platform: "UNIX"
    });
    const archive = join(out, `${app.id}.zip`);
    writeFileSync(archive, bytes);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    return { manifest, archive, digest, size: bytes.length };
}

function walkAll(directory, found = []) {
    for (const entry of readdirSync(directory).sort()) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) walkAll(full, found);
        else found.push(full);
    }
    return found;
}

/** The app packages in this workspace: every one with a `polaris` section. */
export function appPackages(dashboard) {
    const apps = join(dashboard, "apps");
    return readdirSync(apps)
        .map((name) => join(apps, name))
        .filter((dir) => {
            try {
                return Boolean(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).polaris);
            } catch {
                return false;
            }
        })
        .sort();
}

/** The empty JSON object an OCI artifact carries as its config. */
const EMPTY_CONFIG = { mediaType: "application/vnd.oci.empty.v1+json", digest: `sha256:${createHash("sha256").update("{}").digest("hex")}`, size: 2 };

/**
 * The OCI manifest a bundle is published under: the zip as its one layer.
 *
 * Written here rather than by whatever pushes it, and byte for byte what is
 * pushed, so its digest is known before anything is published - which is what
 * lets the registry keep exactly the bundles the latest dashboard names.
 */
export function ociManifest(id, digest, size) {
    const bytes = JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        artifactType: "application/vnd.polaris.app-bundle.v1+zip",
        config: EMPTY_CONFIG,
        layers: [
            {
                mediaType: "application/zip",
                digest,
                size,
                annotations: { "org.opencontainers.image.title": `${id}.zip` }
            }
        ]
    });
    return { bytes, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

async function main() {
    const args = process.argv.slice(2);
    const out = args.shift();
    if (!out) throw new Error("usage: build.mjs <out-dir> [--build <sha>] [<app-dir>...]");
    let build = "";
    const dirs = [];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === "--build") build = args.shift() ?? "";
        else dirs.push(resolve(arg));
    }
    const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const index = { format: BUNDLE_FORMAT, build, apps: {} };
    for (const dir of dirs.length > 0 ? dirs : appPackages(dashboard)) {
        const { manifest, digest, size } = await buildAppBundle(dir, resolve(out), build);
        const oci = ociManifest(manifest.id, digest, size);
        writeFileSync(join(resolve(out), `${manifest.id}.oci.json`), oci.bytes);
        index.apps[manifest.id] = { file: `${manifest.id}.zip`, digest, size, manifest: oci.digest };
        process.stdout.write(`[app-bundles] ${manifest.id}: ${(size / 1024).toFixed(0)} KiB ${digest}\n`);
    }
    writeFileSync(join(resolve(out), "index.json"), `${JSON.stringify(index, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main().catch((error) => {
        process.stderr.write(`${error.stack ?? error}\n`);
        process.exit(1);
    });
}
