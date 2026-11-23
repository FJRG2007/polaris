/**
 * What the launcher window needs from the dashboard to draw its search panel
 * as the dashboard does: the packages the UI sources import, resolved from this
 * app's own `node_modules`, and the stylesheet - the dashboard's design tokens
 * and the Tailwind classes the panel uses, built with the UI package's preset.
 *
 * Resolved here and not from `dashboard/node_modules` on purpose: desktop.yml
 * installs this app alone, and on a machine that has both, two Reacts in one
 * bundle would break every hook.
 */

import postcss from "postcss";
import { build } from "esbuild";
import tailwindcss from "tailwindcss";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, rmSync } from "node:fs";
import { searchSources } from "../../dashboard/packages/ui/src/search/search-styles.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UI = join(ROOT, "..", "dashboard", "packages", "ui", "src");
const CORE = join(ROOT, "..", "dashboard", "packages", "core", "src");

/** Every bare package a dashboard UI source imports, which must come from here. */
const OWN = /^(react|react-dom|scheduler|lucide-react|clsx|tailwind-merge|tailwindcss|tailwindcss-animate)(\/.*)?$/;

/** An esbuild plugin resolving those packages from this app, wherever the importer lives. */
export function ownPackages() {
    return {
        name: "own-packages",
        setup(builder) {
            // The core package's modules by their own names, as main/app-icon reaches them.
            builder.onResolve({ filter: /^@polaris\/core\/[\w-]+$/ }, (args) => ({
                path: join(CORE, `${args.path.slice("@polaris/core/".length)}.ts`)
            }));
            builder.onResolve({ filter: OWN }, async (args) => {
                if (args.pluginData === "own") return undefined;
                const found = await builder.resolve(args.path, {
                    kind: args.kind,
                    resolveDir: ROOT,
                    pluginData: "own"
                });
                return found.errors.length ? { errors: found.errors } : { path: found.path, external: found.external };
            });
        }
    };
}

/** The UI package's Tailwind preset, compiled from its TypeScript with its plugins resolved from here. */
async function preset() {
    const out = join(ROOT, "dist", ".tailwind-preset.mjs");
    await build({
        entryPoints: [join(UI, "tailwind-preset.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        logLevel: "warning",
        plugins: [ownPackages()],
        outfile: out
    });
    try {
        return (await import(pathToFileURL(out).href)).default;
    } finally {
        rmSync(out, { force: true });
    }
}

/** The launcher's stylesheet: the tokens, then Tailwind over the panel's sources and the page. */
export async function launcherCss() {
    const tokens = readFileSync(join(UI, "styles", "tokens.css"), "utf8");
    const page = readFileSync(join(ROOT, "src", "renderer", "launcher.css"), "utf8");
    const config = {
        presets: [await preset()],
        // As the dashboard: `hover:` only where a pointer really hovers.
        future: { hoverOnlyWhenSupported: true },
        content: [...searchSources(UI), join(ROOT, "src", "renderer", "launcher.tsx").replaceAll("\\", "/")]
    };
    const result = await postcss([tailwindcss(config)]).process(`${tokens}\n${page}`, { from: undefined });
    return result.css;
}
