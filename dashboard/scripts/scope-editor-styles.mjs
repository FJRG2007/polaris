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
 * **Fonts are deliberately not included.** A `fonts.css` is a thousand lines of
 * `@font-face` pointing at .ttf and .woff2 files beside it, and getting those
 * through a bundler is a separate job from making the editor look like an
 * editor. Without them a document renders in the nearest installed face, which
 * is what the Electron build did on a machine that lacked them anyway.
 *
 * Run by each package's own build:
 *
 *   node ../../scripts/scope-editor-styles.mjs <scope-class> <sheet> [sheet...]
 *
 * Paths are relative to the package being built. `@ui/x.css` names a sheet in
 * `packages/genoffice-ui/src`, which is where the shared ones live.
 */

import postcss from "postcss";
import { dirname, join, resolve } from "node:path";
import selectorParser from "postcss-selector-parser";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const dashboard = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the shared sheets live, so a package names them once rather than
 *  walking out of its own directory in every argument. */
function locate(sheet) {
    return sheet.startsWith("@ui/")
        ? join(dashboard, "packages", "genoffice-ui", "src", sheet.slice("@ui/".length))
        : resolve(process.cwd(), sheet);
}

/** What a selector means once it is a panel rather than the page. */
const AS_THE_PANEL = new Set([":root", "html", "body", "#root", ".app"]);

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
    const [scopeClass, ...sheets] = process.argv.slice(2);
    if (!scopeClass || sheets.length === 0) {
        process.stderr.write("usage: scope-editor-styles.mjs <scope-class> <sheet> [sheet...]\n");
        process.exit(2);
    }
    const scoped = sheets
        .map((named) => {
            const sheet = locate(named);
            const css = scopeCss(readFileSync(sheet, "utf8"), scopeClass, sheet);
            return `/* ${named} */\n${css}`;
        })
        .join("\n\n");
    const target = join(process.cwd(), "dist", "styles.css");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${scoped}\n`, "utf8");
    process.stdout.write(`[scope-editor-styles] ${sheets.length} sheets -> ${target}\n`);
}
