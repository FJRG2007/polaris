/**
 * Fence a vendored editor's stylesheets inside the editor.
 *
 * The GenOffice editors were written to be a whole window. Between them they
 * carry ten thousand lines of CSS that style `*`, `html`, `body`, `button` and
 * `:root` directly, because in Electron that page IS the application and there
 * is nothing else on it. In Polaris each is a panel inside a screen, and a
 * stylesheet like that reaches the rest of it: the surrounding buttons, the
 * page's background, every custom property the design system defines.
 *
 * So every selector is rewritten to sit under one class. The few that describe
 * the page itself become that class rather than a descendant of it:
 *
 *   :root, html, body, #root, .app  ->  .<scope>     (properties land here)
 *   *                               ->  .<scope> *
 *   .ribbon                         ->  .<scope> .ribbon
 *
 * Media and supports blocks are walked into rather than around; keyframes are
 * left alone, because a keyframe's "selector" is a percentage; `@font-face`
 * carries no selector at all and is untouched.
 *
 * The sheets are concatenated in the order the editor's own entry point imports
 * them, because the cascade is part of what they say, and the result is one file
 * - so the screen that renders the editor has one import and cannot get the
 * order wrong.
 *
 * **Fonts are included, and they are why `--assets` exists.** A `fonts.css` is a
 * thousand lines of `@font-face` pointing at .ttf and .woff2 files beside it, by
 * a path that means something to the editor's own bundler and nothing to this
 * one. Without them a document renders in the nearest installed face - which is
 * a document that looks wrong, since the faces in question are the metric
 * substitutes a .docx names: Carlito for Calibri, Caladea for Cambria. A page
 * laid out for one and drawn in another breaks its own line endings.
 *
 * So every `url()` that names a file is rewritten to `<assets>/<file name>`, one
 * flat directory the browser can ask this origin for, and the files themselves
 * are staged into `public/` at build time by the web app's own
 * `copy-office-fonts` step. A `url()` that already resolves is left exactly as
 * it is: `data:` is already the file, `http(s):` is somebody else's server, and
 * a root-absolute path or a `#` fragment is something this document already
 * answers.
 *
 * Run by each package's own build:
 *
 *   node ../../scripts/scope-editor-styles.mjs <scope-class> [--assets=<base>] <sheet> [sheet...]
 *
 * Paths are relative to the package being built. `@ui/x.css` names a sheet in
 * `packages/genoffice-ui/src`, which is where the shared ones live, and
 * `pkg:<specifier>` one inside a dependency, resolved rather than reached for by
 * a path through `node_modules`.
 */

import postcss from "postcss";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import selectorParser from "postcss-selector-parser";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const dashboard = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where a named sheet actually is.
 *
 * `@ui/x.css` is one of the shared sheets, so a package names it once rather
 * than walking out of its own directory in every argument.
 *
 * `pkg:katex/dist/katex.min.css` is a sheet inside a dependency, resolved the
 * way the package being built resolves it. A hardcoded `../../node_modules/...`
 * would instead find whichever copy npm happened to hoist - which is a different
 * version of the package the moment anything else in the tree asks for one, and
 * the sheet it reads then belongs to neither the code that ships beside it nor
 * the fonts staged for it.
 */
function locate(sheet) {
    if (sheet.startsWith("@ui/")) {
        return join(dashboard, "packages", "genoffice-ui", "src", sheet.slice("@ui/".length));
    }
    if (sheet.startsWith("pkg:")) {
        return createRequire(join(process.cwd(), "package.json")).resolve(
            sheet.slice("pkg:".length)
        );
    }
    return resolve(process.cwd(), sheet);
}

/** What a selector means once it is a panel rather than the page. */
const AS_THE_PANEL = new Set([":root", "html", "body", "#root", ".app"]);

/** A `url()` that already resolves on its own: the file inlined into the
 *  stylesheet, somebody else's server, and what this origin already answers - a
 *  root-absolute path, and a `#` fragment naming an SVG filter in the document.
 *  None of them is a staged asset, and flattening one to a bare file name breaks
 *  a reference that worked. */
const RESOLVES_ITSELF = /^(?:data:|https?:|[/#])/i;

/**
 * Point every `url()` at one flat directory of staged files.
 *
 * The editors reference their fonts the way their own bundler resolved them -
 * `@genoffice/ui/fonts/Carlito-Regular.ttf` beside `./Caladea-Regular.ttf` - and
 * neither survives being served from a Next application. Both name a file, and
 * the file is what is staged, so the name is all this keeps.
 *
 * Exported for the test: a rewrite that quietly dropped `data:` would inline
 * nothing and a rewrite that mangled a remote URL would fetch nothing, and both
 * look like a font that simply did not load.
 */
export function pointAtAssets(css, base) {
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, _quote, target) => {
        const path = target.trim();
        if (!path || RESOLVES_ITSELF.test(path)) return whole;
        const file = path.split(/[\\/]/).pop();
        return `url('${base.replace(/\/$/, "")}/${file}')`;
    });
}

/**
 * One stylesheet, rewritten to live under one class.
 *
 * Exported so it can be tested on its own: what this does is the difference
 * between an editor in a panel and an editor that restyles the screen around it,
 * and that is not something anybody should find out from a screenshot.
 */
export function scopeCss(css, scopeClass, from = "input.css") {
    const scope = selectorParser((selectors) => {
        selectors.each((selector) => {
            if (AS_THE_PANEL.has(String(selector).trim())) {
                selector.removeAll();
                selector.append(selectorParser.className({ value: scopeClass }));
                return;
            }
            // Everything else becomes a descendant. `*` included: `.<scope> *`
            // is every element in the panel and nothing outside it.
            selector.prepend(selectorParser.combinator({ value: " " }));
            selector.prepend(selectorParser.className({ value: scopeClass }));
        });
    });
    return postcss([
        {
            postcssPlugin: "scope-editor-styles",
            Once(tree) {
                tree.walkRules((rule) => {
                    const at = rule.parent?.type === "atrule" ? rule.parent.name : "";
                    if (at.endsWith("keyframes")) return;
                    rule.selector = scope.processSync(rule.selector);
                });
            }
        }
    ]).process(css, { from }).css;
}

// Run as a command rather than imported: one file, built from the sheets named
// on the line.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const flags = args.filter((arg) => arg.startsWith("--"));
    const [scopeClass, ...sheets] = args.filter((arg) => !arg.startsWith("--"));
    const given = flags.filter((flag) => flag.startsWith("--assets="));
    const assets = given.at(-1)?.slice("--assets=".length).trim();
    const unknown = flags.find((flag) => !flag.startsWith("--assets="));
    // A flag misspelt or left empty must not be dropped on the floor. The sheets
    // would still be written, still carrying the editors' own unresolvable font
    // paths, and the only sign of it is a document drawn at the wrong widths,
    // long after the build went green.
    const wrong =
        !scopeClass || sheets.length === 0
            ? "a scope class and at least one sheet are required"
            : unknown
              ? `unrecognized argument: ${unknown}`
              : given.length > 0 && !assets
                ? "--assets needs a base path, as in --assets=/office-fonts"
                : "";
    if (wrong) {
        process.stderr.write(
            `[scope-editor-styles] ${wrong}\nusage: scope-editor-styles.mjs <scope-class> [--assets=<base>] <sheet> [sheet...]\n`
        );
        process.exit(2);
    }
    const scoped = sheets
        .map((named) => {
            const sheet = locate(named);
            const read = readFileSync(sheet, "utf8");
            const css = scopeCss(assets ? pointAtAssets(read, assets) : read, scopeClass, sheet);
            return `/* ${named} */\n${css}`;
        })
        .join("\n\n");
    const target = join(process.cwd(), "dist", "styles.css");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${scoped}\n`, "utf8");
    process.stdout.write(`[scope-editor-styles] ${sheets.length} sheets -> ${target}\n`);
}
