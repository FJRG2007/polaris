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

import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const dashboard = join(here, "..", "..", "..");

/**
 * The formula stylesheet, resolved from the editor that declares KaTeX rather
 * than from here.
 *
 * Resolving it from this app finds whichever copy npm hoisted to the root, which
 * is today a different version pulled in by something else entirely. The faces
 * staged from it would then belong to a different KaTeX than the one the Markdown
 * editor's stylesheet was built from - and the Markdown editor builds this same
 * sheet with `pkg:katex/dist/katex.min.css`, which resolves it the same way.
 */
export const katexSheet = createRequire(
    join(dashboard, "packages", "genoffice-markdown", "package.json")
).resolve("katex/dist/katex.min.css");

/** The one path the browser asks this origin for. The editors' builds are
 *  handed it as `--assets=<base>` and this step fills the directory it names, so
 *  the two halves have to spell it the same way - hence one exported name rather
 *  than the same string written in three places. */
export const base = "/office-fonts";

export const target = join(here, "..", "public", base.replace(/^\//, ""));

/** Every directory that holds faces the editors' stylesheets name, each with the
 *  package it belongs to. The faces are staged flat, because two sheets
 *  referencing the same family by different paths - which is what
 *  `@genoffice/ui/fonts/Carlito-Regular.ttf` and `./Carlito-Regular.ttf` are -
 *  have to land on one file. The notices beside them cannot be: two of these
 *  directories call theirs `README.md`, and only a face's name has to survive. */
export const sources = [
    {
        label: "genoffice-docs",
        dir: join(dashboard, "packages", "genoffice-docs", "src", "renderer", "fonts")
    },
    { label: "genoffice-ui", dir: join(dashboard, "packages", "genoffice-ui", "src", "fonts") },
    { label: "katex", dir: join(dirname(katexSheet), "fonts") }
];

export const FACE = /\.(ttf|otf|woff2?|eot)$/i;

/** What has to travel with the faces rather than stay behind in the checkout.
 *  Carlito, Liberation and the Noto/GenOffice faces are OFL 1.1, which requires
 *  the licence text to accompany every redistributed copy, and these files are
 *  now published at `/office-fonts` for any browser to fetch. The README is part
 *  of it: it is what records that Caladea is Apache-2.0 rather than OFL, and
 *  which faces are renamed derivatives under OFL 1.1 §2. */
export const NOTICE = /^(?:licen[cs]e|copying|notice|readme)\b/i;

/**
 * Fill `into` with every face the sources hold and the licences that cover them,
 * and throw if a source has no faces or if two of them stage the same name.
 *
 * A source that has moved must stop the build rather than be skipped. Staging
 * nothing is not a visible failure anywhere downstream: the stylesheets still
 * ask for the files, the browser still gets a 404 for each, and every document
 * is drawn in a fallback face at the wrong widths - which is the exact outcome
 * this step exists to prevent, arrived at with a green build.
 *
 * A repeated file name is the same failure wearing the other hat. The sources
 * are disjoint today, but flattened into one directory the last copy silently
 * wins, and the document is then drawn in a real face that is the wrong one -
 * again with a green build. So it is refused by name here instead.
 */
export function stageFonts(into = target) {
    rmSync(into, { recursive: true, force: true });
    mkdirSync(into, { recursive: true });
    const faces = new Set();
    let notices = 0;
    for (const { label, dir } of sources) {
        const names = readdirSync(dir);
        const found = names.filter((name) => FACE.test(name));
        if (found.length === 0) throw new Error(`No font files under ${dir}`);
        for (const name of found) {
            if (faces.has(name))
                throw new Error(
                    `Two font sources stage a file named ${name}; ${dir} would replace the first`
                );
            faces.add(name);
            copyFileSync(join(dir, name), join(into, name));
        }
        for (const name of names.filter((it) => !FACE.test(it) && NOTICE.test(it))) {
            copyFileSync(join(dir, name), join(into, `${label}-${name}`));
            notices += 1;
        }
    }
    return { faces: faces.size, notices };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { faces, notices } = stageFonts();
    console.log(`Copied ${faces} office font files and ${notices} licence files to ${target}`);
}
