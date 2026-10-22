/**
 * Builds the site's data before `next build`: bundles `generate.ts` against the
 * dashboard's own path aliases, so the catalogue and the API document are the
 * dashboard's modules imported as they are, then runs it.
 */

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "..");
// Written beside the dashboard's own dependencies, so the modules it imports
// resolve the versions the dashboard does (its zod is not the workspace's).
const out = join(site, "..", "web", "node_modules", ".cache", "polaris-site", "generate.mjs");
mkdirSync(dirname(out), { recursive: true });

await build({
    entryPoints: [join(here, "generate.ts")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    jsx: "automatic",
    tsconfig: join(site, "..", "web", "tsconfig.json"),
    // Packages load from node_modules as they are, except the UI package, which
    // ships its TypeScript sources and so has to be bundled.
    plugins: [
        {
            name: "external-packages",
            setup(builder) {
                // esbuild filters are Go regular expressions, which have no lookahead,
                // so the choice is made here instead.
                builder.onResolve({ filter: /.*/ }, (args) => {
                    const bare = !/^(\.|\/|[A-Za-z]:|@\/)/.test(args.path);
                    const ui = args.path === "@polaris/ui" || args.path.startsWith("@polaris/ui/");
                    return bare && !ui ? { path: args.path, external: true } : undefined;
                });
            }
        }
    ],
    logLevel: "warning"
});

// The bundle runs from elsewhere, so it is told where the site is.
process.env.POLARIS_SITE_DIR = site;
await import(pathToFileURL(out).href);
