/**
 * Stage the embedded editors' fonts under public/office-fonts.
 *
 * The Word and Markdown editors carry their own faces, and they are not
 * decoration. A .docx names Calibri and Cambria; the machine that opens it
 * usually has neither, and what the editors ship are the metric-compatible
 * substitutes - Carlito and Caladea - which occupy exactly the same widths. Draw
 * a page laid out for Calibri in whatever the browser falls back to and every
 * line ends somewhere else, which is a document that looks wrong rather than a
 * document in a different font. The rest are the CJK and symbol faces the
 * editors reference by name, and KaTeX's, without which a formula renders as a
 * column of boxes.
 *
 * Their stylesheets are rewritten to point here, at one flat directory, by
 * `scripts/scope-editor-styles.mjs --assets=/office-fonts` - the editors' own
 * paths (`@genoffice/ui/fonts/...` beside `./Caladea-Regular.ttf`) mean
 * something to their bundler and nothing to this one, so the file name is all
 * that is kept and this is what has to make that name resolvable.
 *
 * Copied at build time rather than committed, like the pdf.js and audio assets:
 * these files must match the installed packages, and a stale copy of a font is
 * the kind of thing nobody notices until a document is printed.
 */

import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const dashboard = join(here, "..", "..", "..");
const target = join(here, "..", "public", "office-fonts");

/** Every directory that holds faces the editors' stylesheets name. Flat on
 *  purpose: two sheets referencing the same family by different paths - which is
 *  what `@genoffice/ui/fonts/Carlito-Regular.ttf` and `./Carlito-Regular.ttf`
 *  are - have to land on one file. */
const sources = [
    join(dashboard, "packages", "genoffice-docs", "src", "renderer", "fonts"),
    join(dashboard, "packages", "genoffice-ui", "src", "fonts"),
    join(dirname(require.resolve("katex/dist/katex.min.css")), "fonts")
];

const FACE = /\.(ttf|otf|woff2?|eot)$/i;

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

let copied = 0;
for (const source of sources) {
    if (!existsSync(source)) continue;
    for (const name of readdirSync(source)) {
        if (!FACE.test(name)) continue;
        copyFileSync(join(source, name), join(target, basename(name)));
        copied += 1;
    }
}

console.log(`Copied ${copied} office font files to ${target}`);
