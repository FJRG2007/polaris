/**
 * Physical-direction Tailwind classes, rewritten to the logical ones that follow
 * `<html dir>` - and the list of where that would be wrong.
 *
 * A right-to-left language mirrors the interface: what sits on the left in
 * English sits on the right in Arabic. `ml-2` is always the left margin; `ms-2`
 * is the margin at the start of the line, left in English and right in Arabic.
 * Tailwind 3.4 has the logical form of every utility rewritten here (`ms`/`me`,
 * `ps`/`pe`, `start`/`end`, `text-start`, `rounded-s`/`ss`, `border-s`,
 * `scroll-ms`, `float-start`, `clear-start`). `space-x-*` and `divide-x` have
 * none, so they keep their class and gain `rtl:space-x-reverse` /
 * `rtl:divide-x-reverse` beside it.
 *
 * Only the text of string literals is read (found with the TypeScript parser,
 * not a regular expression over the file), and only whole class tokens are
 * changed, so `right-click` in a sentence and `"left"` as a value stay as they
 * are.
 *
 *   node scripts/rtl-logical.mjs            rewrite every file in scope
 *   node scripts/rtl-logical.mjs --check    list what would change, write nothing
 *   node scripts/rtl-logical.mjs --baseline write scripts/rtl-physical.json
 *
 * The guard (`test/i18n/rtl-classes.test.ts`) runs the same detection, so a new
 * physical class outside the exclusions below fails the suite.
 */

import ts from "typescript";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

/** The dashboard workspace root. */
export const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

/** The files whose classes become CSS: the directories the dashboard's and the
 *  site's Tailwind configs scan (see `apps/web/tailwind.config.ts`). */
export const SCOPE = [
    "apps/web/src",
    "apps/site/src",
    "packages/ui/src",
    "apps/places/src",
    "apps/game-servers/src",
    "apps/calendar/src",
    "apps/crm/src",
    "apps/status-pages/src",
    "apps/translate/src",
    "apps/security-scans/src",
    "apps/cloud-servers/src"
];

/**
 * Files whose left and right are the picture's, not the reading direction's.
 * Each keeps its physical classes, and the guard does not look at it.
 */
export const EXCLUDED = [
    // Node graphs: a node's ports and the edges drawn to them are positioned in
    // physical canvas coordinates, so a port's `left-0` is where its edge lands.
    { path: "packages/ui/src/automation/canvas.tsx", reason: "graph canvas coordinates" },
    { path: "packages/ui/src/automation/diagram.tsx", reason: "graph canvas coordinates" },
    { path: "apps/web/src/app/(app)/automations/[id]/canvas-board.tsx", reason: "graph canvas coordinates" },
    { path: "apps/web/src/app/(app)/apps/deploy/deploy-canvas.tsx", reason: "graph canvas coordinates" },
    // A slider's fill and thumb are placed by an inline `left`/`width` from the value.
    { path: "packages/ui/src/components/control-slider.tsx", reason: "track filled by inline physical offsets" },
    // Terminal output is a fixed left-to-right grid.
    { path: "apps/web/src/app/(app)/apps/deploy/terminal-panel.tsx", reason: "terminal grid" },
    // Video and camera overlays sit on the picture, which is never mirrored.
    { path: "apps/web/src/app/(app)/chat/call-room.tsx", reason: "video tile overlays" },
    { path: "apps/web/src/app/(app)/chat/call-annotate.tsx", reason: "drawing over a shared screen" },
    { path: "apps/web/src/app/(app)/chat/call-preview.tsx", reason: "video tile overlays" },
    { path: "apps/web/src/components/video-viewer.tsx", reason: "video overlays" },
    { path: "apps/web/src/components/video-preview.tsx", reason: "video overlays" },
    { path: "apps/web/src/components/media-player.tsx", reason: "media timeline" },
    { path: "apps/web/src/components/file-picker/camera-capture.tsx", reason: "camera overlays" },
    { path: "apps/places/src/screens/camera-tile.tsx", reason: "camera overlays" },
    { path: "apps/places/src/screens/camera-viewer.tsx", reason: "camera overlays" },
    { path: "apps/places/src/screens/cameras/**", reason: "camera overlays and zones drawn on the picture" },
    { path: "apps/places/src/screens/guest/guest-camera-view.tsx", reason: "camera overlays" },
    { path: "apps/translate/src/screens/camera-mode.tsx", reason: "camera overlays" },
    { path: "apps/translate/src/screens/translated-picture.tsx", reason: "text placed over a photo" },
    // Pictures, maps, plots and charts have their own axes.
    { path: "apps/web/src/components/image-cropper.tsx", reason: "crop box in image coordinates" },
    { path: "apps/web/src/components/image-actions.tsx", reason: "image coordinates" },
    { path: "apps/web/src/components/map/**", reason: "map coordinates" },
    { path: "apps/web/src/app/(app)/office/c/[id]/positioning-map.tsx", reason: "plot axes" },
    { path: "apps/web/src/components/polar/visuals/visual-chart.tsx", reason: "chart axes" },
    { path: "apps/crm/src/screens/widget-charts.tsx", reason: "chart axes" },
    // A slide and a spreadsheet grid are documents laid out in their own coordinates.
    { path: "apps/web/src/app/(app)/office/p/[id]/slides-editor.tsx", reason: "slide canvas" },
    { path: "apps/web/src/app/(app)/office/s/[id]/sheet-editor.tsx", reason: "spreadsheet grid" },
    { path: "apps/web/src/app/(app)/drive/viewer/sheet-editor.tsx", reason: "spreadsheet grid" },
    // The profile sheen is a wide layer its keyframes slide along x.
    { path: "apps/web/src/lib/profile-style-css.ts", reason: "sheen animated on the x axis" }
];

const EXCLUDED_PATTERNS = EXCLUDED.map(({ path }) => {
    const escaped = path.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*");
    return new RegExp(`^${escaped}$`);
});

/** Whether a workspace-relative path (forward slashes) keeps its physical classes. */
export function isExcluded(path) {
    return EXCLUDED_PATTERNS.some((pattern) => pattern.test(path));
}

const SPACING = String.raw`(?:\d+(?:\.\d+)?|px|auto|\[[^\]\s]+\])`;
const INSET = String.raw`(?:\d+(?:\.\d+)?|px|auto|full|\d+\/\d+|\[[^\]\s]+\])`;
const RADIUS = String.raw`(?:none|sm|md|lg|xl|2xl|3xl|full|\[[^\]\s]+\])`;
const BORDER = String.raw`(?:\d+|\[[^\]\s]+\]|[a-z][\w\-./]*)`;

const SIDE = { l: "s", r: "e", left: "start", right: "end" };
const CORNER = { l: "s", r: "e", tl: "ss", tr: "se", bl: "es", br: "ee" };

/**
 * Each rule: a pattern for the class without its variants, `!` or `-`, and what
 * it becomes. Rules that cannot be logical in Tailwind 3.4 are not here.
 */
const RULES = [
    { pattern: new RegExp(`^(m|p)(l|r)-(${SPACING})$`), to: (m) => `${m[1]}${SIDE[m[2]]}-${m[3]}` },
    { pattern: new RegExp(`^scroll-(m|p)(l|r)-(${SPACING})$`), to: (m) => `scroll-${m[1]}${SIDE[m[2]]}-${m[3]}` },
    { pattern: new RegExp(`^(left|right)-(${INSET})$`), to: (m) => `${SIDE[m[1]]}-${m[2]}`, inset: true },
    { pattern: /^text-(left|right)$/, to: (m) => `text-${SIDE[m[1]]}` },
    { pattern: new RegExp(`^rounded-(l|r|tl|tr|bl|br)(-${RADIUS})?$`), to: (m) => `rounded-${CORNER[m[1]]}${m[2] ?? ""}` },
    { pattern: new RegExp(`^border-(l|r)(-${BORDER})?$`), to: (m) => `border-${SIDE[m[1]]}${m[2] ?? ""}` },
    { pattern: /^(float|clear)-(left|right)$/, to: (m) => `${m[1]}-${SIDE[m[2]]}` }
];

/** Physical classes with no logical form, which get their `rtl:` reverse beside them. */
const REVERSIBLE = [
    { pattern: new RegExp(`^space-x-(${SPACING}|reverse)$`), reverse: "space-x-reverse" },
    { pattern: /^divide-x(-\d+|-\[[^\]\s]+\]|-reverse)?$/, reverse: "divide-x-reverse" }
];

/** `md:hover:-ml-2` -> variants `md:hover:`, important `""`, negative `-`, core `ml-2`.
 *  The last `:` outside brackets ends the variants (`data-[state=open]:`). */
function splitToken(token) {
    let depth = 0;
    let cut = -1;
    for (let index = 0; index < token.length; index++) {
        const char = token[index];
        if (char === "[") depth++;
        else if (char === "]") depth--;
        else if (char === ":" && depth === 0) cut = index;
    }
    const variants = token.slice(0, cut + 1);
    let rest = token.slice(cut + 1);
    const important = rest.startsWith("!") ? "!" : "";
    rest = rest.slice(important.length);
    const negative = rest.startsWith("-") ? "-" : "";
    return { variants, important, negative, core: rest.slice(negative.length) };
}

/**
 * The rewritten class list, or the same text when nothing in it is physical.
 *
 * `left-1/2`/`right-1/2` are kept: with `-translate-x-1/2` they centre, which
 * is the same in every language. A list that translates on x is kept whole: it
 * is a drawer pinned to one edge over a dialog centred with physical `left` (a
 * logical `start` would lose to that `left` in the stylesheet) or something
 * that slides on the screen's axis, and changing only its corners and borders
 * would leave them on the wrong side of it.
 */
export function rewriteClassList(text) {
    if (/(^|[\s:])-?translate-x-/.test(text)) return { text, changes: [] };
    const tokens = text.split(/(\s+)/);
    const changes = [];
    const added = [];
    for (let index = 0; index < tokens.length; index += 2) {
        const token = tokens[index];
        if (!token) continue;
        const { variants, important, negative, core } = splitToken(token);
        for (const rule of RULES) {
            const match = rule.pattern.exec(core);
            if (!match) continue;
            if (rule.inset && match[2] === "1/2") break;
            const next = `${variants}${important}${negative}${rule.to(match)}`;
            changes.push({ from: token, to: next });
            tokens[index] = next;
            break;
        }
        for (const { pattern, reverse } of REVERSIBLE) {
            const match = pattern.exec(core);
            if (!match || match[1] === "reverse" || match[1] === "-reverse") continue;
            const wanted = `${variants}rtl:${reverse}`;
            if (text.includes(reverse) || added.includes(wanted)) continue;
            added.push(wanted);
            changes.push({ from: token, to: `${token} ${wanted}` });
        }
    }
    if (changes.length === 0) return { text, changes };
    let result = tokens.join("");
    if (added.length > 0) {
        const trailing = /\s*$/.exec(result)[0];
        result = `${result.slice(0, result.length - trailing.length)} ${added.join(" ")}${trailing}`;
    }
    return { text: result, changes };
}

/** The editable text spans of every string literal and template chunk in a file. */
function literalSpans(source, fileName) {
    const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
    const spans = [];
    const visit = (node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            spans.push({ start: node.getStart(file) + 1, end: node.end - 1, open: true, close: true });
        } else if (ts.isTemplateExpression(node)) {
            const head = node.head;
            spans.push({ start: head.getStart(file) + 1, end: head.end - 2, open: true, close: false });
            for (const span of node.templateSpans) {
                const literal = span.literal;
                const tail = ts.isTemplateTail(literal);
                spans.push({ start: literal.getStart(file) + 1, end: literal.end - (tail ? 1 : 2), open: false, close: tail });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return spans;
}

/**
 * The file with its physical classes made logical, and what changed. A token
 * that touches a `${...}` is left alone: half of it is not in the literal.
 */
export function rewriteSource(source, fileName = "file.tsx") {
    const spans = literalSpans(source, fileName).sort((a, b) => b.start - a.start);
    const changes = [];
    let result = source;
    for (const span of spans) {
        if (span.end <= span.start) continue;
        let text = result.slice(span.start, span.end);
        if (text.includes("\n") && !/^[\s\w\-:!/.[\]=&>*()%#,@'"]*$/.test(text)) continue;
        let lead = "";
        let tail = "";
        if (!span.open) {
            const m = /^\S*/.exec(text)[0];
            lead = m;
            text = text.slice(m.length);
        }
        if (!span.close) {
            const m = /\S*$/.exec(text)[0];
            tail = m;
            text = text.slice(0, text.length - m.length);
        }
        const rewritten = rewriteClassList(text);
        if (rewritten.changes.length === 0) continue;
        changes.push(...rewritten.changes);
        result = result.slice(0, span.start) + lead + rewritten.text + tail + result.slice(span.end);
    }
    return { source: result, changes };
}

/** Every `.ts`/`.tsx` file in scope, workspace-relative with forward slashes. */
export function scopedFiles() {
    const files = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            if (name === "node_modules" || name.startsWith(".")) continue;
            const full = join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) files.push(relative(ROOT, full).split(sep).join("/"));
        }
    };
    for (const dir of SCOPE) walk(join(ROOT, dir));
    return files.sort();
}

/** `{ file: count }` of the physical classes left outside the exclusions. */
export function physicalClasses() {
    const found = {};
    for (const file of scopedFiles()) {
        if (isExcluded(file)) continue;
        const { changes } = rewriteSource(readFileSync(join(ROOT, file), "utf8"), file);
        if (changes.length > 0) found[file] = changes.length;
    }
    return found;
}

export const BASELINE = resolve(ROOT, "apps/web/scripts/rtl-physical.json");

function main(args) {
    if (args.includes("--baseline")) {
        writeFileSync(BASELINE, `${JSON.stringify(physicalClasses(), null, 4)}\n`);
        return;
    }
    const check = args.includes("--check");
    let files = 0;
    let total = 0;
    for (const file of scopedFiles()) {
        if (isExcluded(file)) continue;
        const path = join(ROOT, file);
        const before = readFileSync(path, "utf8");
        const { source, changes } = rewriteSource(before, file);
        if (changes.length === 0) continue;
        files++;
        total += changes.length;
        if (check) for (const { from, to } of changes) console.log(`${file}: ${from} -> ${to}`);
        else writeFileSync(path, source);
    }
    console.log(`${total} classes in ${files} files${check ? " would change" : " rewritten"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
