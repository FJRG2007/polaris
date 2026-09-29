/**
 * How much of the interface still speaks only English, area by area.
 *
 * A heuristic, and says so: it reads every source file with the TypeScript
 * parser and reports the string literals a person is likely to read - text
 * between JSX tags, the props that end up on screen or in a screen reader
 * (`title`, `placeholder`, `aria-label`, `label`, `alt`...), and the same names
 * as object properties (`{ label: "..." }`, `{ error: "..." }`), which is how
 * option lists, toasts and server-action replies carry their words. What looks
 * like an identifier, a path or a class name is skipped. A literal that is not
 * copy can be marked `// i18n-ignore` on its line or the line above.
 *
 * It measures migration; it does not block anything by itself. The test next
 * to the catalogs (`test/i18n/scan.test.ts`) holds every file listed in
 * `scripts/i18n-migrated.json` to zero findings, so a migrated screen cannot
 * drift back.
 *
 *   node scripts/i18n-scan.mjs              areas, most strings first
 *   node scripts/i18n-scan.mjs --list chat  every finding in one area
 *   node scripts/i18n-scan.mjs --json       the same data, for a tool
 */

import ts from "typescript";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS = join(WEB, "..");

/** The props and properties whose string value is read by a person. */
export const COPY_NAMES = new Set([
    "title",
    "label",
    "description",
    "placeholder",
    "alt",
    "hint",
    "message",
    "error",
    "aria-label",
    "aria-description",
    "aria-valuetext",
    "aria-placeholder",
    "featuredLabel",
    "emptyLabel",
    "confirmLabel",
    "cancelLabel"
]);

/**
 * Whether a literal reads as copy rather than as a value.
 *
 * Copy has a letter in it, and either a space or a capital: "Save", "Set a
 * status". Values do not - "auto", "on-hover", "/account", "px", "utf-8".
 */
export function looksLikeCopy(text) {
    const value = text.replace(/\s+/g, " ").trim();
    if (!/\p{L}/u.test(value)) return false;
    if (/^(https?:|mailto:|\/|\.\/|#|@)/.test(value)) return false;
    // A single token with no capital and no space is an identifier, a unit, a
    // keyword - never a sentence.
    if (!/\s/.test(value) && !/\p{Lu}/u.test(value)) return false;
    // SCREAMING_CASE constants, dotted keys, and file names. An acronym on its
    // own ("OK", "2FA") is copy.
    if (/^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(value) || /^[\w-]+(\.[\w-]+)+$/.test(value)) return false;
    return true;
}

function attributeName(node) {
    return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
        ? node.name.text
        : node.name.getText();
}

/** The literal strings inside an expression that end up on screen as they are:
 *  the expression itself, either side of a ternary or `??`/`||`, a template. */
function literalsIn(expression) {
    if (!expression) return [];
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression];
    if (ts.isTemplateExpression(expression)) return [expression];
    if (ts.isParenthesizedExpression(expression)) return literalsIn(expression.expression);
    if (ts.isConditionalExpression(expression)) return [...literalsIn(expression.whenTrue), ...literalsIn(expression.whenFalse)];
    if (ts.isBinaryExpression(expression) && ["??", "||"].includes(expression.operatorToken.getText()))
        return [...literalsIn(expression.left), ...literalsIn(expression.right)];
    return [];
}

function textOf(literal) {
    if (ts.isTemplateExpression(literal)) {
        return [literal.head.text, ...literal.templateSpans.map((span) => span.literal.text)].join(" {} ");
    }
    return literal.text;
}

/**
 * The findings in one source text. Pure, so the test can feed it fixtures.
 *
 * @returns {{ line: number, kind: "text" | "prop" | "property", name: string, text: string }[]}
 */
export function scanSource(source, fileName = "file.tsx") {
    const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
    const lines = source.split("\n");
    const ignored = (line) => /i18n-ignore/.test(lines[line] ?? "") || /i18n-ignore/.test(lines[line - 1] ?? "");
    const found = [];
    const report = (node, kindOf, name, text) => {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
        if (ignored(line) || !looksLikeCopy(text)) return;
        found.push({ line: line + 1, kind: kindOf, name, text: text.replace(/\s+/g, " ").trim() });
    };

    const visit = (node) => {
        if (ts.isJsxText(node)) {
            report(node, "text", "", node.text);
        } else if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
            for (const literal of literalsIn(node.expression)) report(literal, "text", "", textOf(literal));
        } else if (ts.isJsxAttribute(node) && COPY_NAMES.has(attributeName(node))) {
            const value = node.initializer;
            const literals = !value
                ? []
                : ts.isStringLiteral(value)
                  ? [value]
                  : ts.isJsxExpression(value)
                    ? literalsIn(value.expression)
                    : [];
            for (const literal of literals) report(literal, "prop", attributeName(node), textOf(literal));
        } else if (ts.isPropertyAssignment(node) && COPY_NAMES.has(attributeName(node))) {
            for (const literal of literalsIn(node.initializer)) report(literal, "property", attributeName(node), textOf(literal));
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
}

/**
 * The area a file belongs to - roughly, the namespace its strings will go to.
 * `app/(app)/chat/...` is `chat`, `app/(app)/apps/deploy/...` is `apps/deploy`,
 * `components/transfers/...` is `components/transfers`, an installed app is
 * its own name.
 */
export function areaOf(path) {
    const parts = path.split(/[\\/]/).filter((part) => part !== "" && !/^\(.*\)$/.test(part));
    const [root = "", ...rest] = parts;
    if (root !== "web") return root;
    const [, top = "", first = "", second = ""] = rest; // src, app|components|lib, ...
    const isDir = (name) => name !== "" && !/\.[jt]sx?$/.test(name);
    if (top === "app") return first === "apps" && isDir(second) ? `apps/${second}` : isDir(first) ? first : "app";
    return isDir(first) ? `${top}/${first}` : top;
}

/** Every source file the scan reads: the dashboard's and each installed app's. */
function sourceFiles() {
    const files = [];
    const walk = (directory) => {
        for (const entry of readdirSync(directory)) {
            const full = join(directory, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|d)\.tsx?$/.test(entry)) files.push(full);
        }
    };
    for (const app of readdirSync(APPS)) {
        const src = join(APPS, app, "src");
        try {
            if (statSync(src).isDirectory()) walk(src);
        } catch {
            // An app with no sources of its own.
        }
    }
    return files;
}

/** Every finding, with the file it is in (relative to `apps/`) and its area. */
export function scan(files = sourceFiles()) {
    return files.flatMap((full) => {
        const path = relative(APPS, full).split(sep).join("/");
        // The engine itself, whose strings are the ones that report problems.
        if (path.startsWith("web/src/lib/i18n/")) return [];
        return scanSource(readFileSync(full, "utf8"), full).map((finding) => ({ ...finding, path, area: areaOf(path) }));
    });
}

function main(args) {
    const findings = scan();
    if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
        return;
    }
    const listed = args.indexOf("--list");
    if (listed >= 0) {
        const area = args[listed + 1] ?? "";
        for (const finding of findings.filter((entry) => entry.area === area)) {
            console.log(`${finding.path}:${finding.line}  ${finding.kind}${finding.name ? ` ${finding.name}` : ""}  ${finding.text}`);
        }
        return;
    }
    const byArea = new Map();
    for (const finding of findings) {
        const entry = byArea.get(finding.area) ?? { strings: 0, files: new Set() };
        entry.strings += 1;
        entry.files.add(finding.path);
        byArea.set(finding.area, entry);
    }
    const rows = [...byArea].sort((left, right) => right[1].strings - left[1].strings);
    const width = Math.max(4, ...rows.map(([area]) => area.length));
    console.log(`${"area".padEnd(width)}  strings  files`);
    for (const [area, entry] of rows) {
        console.log(`${area.padEnd(width)}  ${String(entry.strings).padStart(7)}  ${String(entry.files.size).padStart(5)}`);
    }
    console.log(`${"total".padEnd(width)}  ${String(findings.length).padStart(7)}  ${String(new Set(findings.map((f) => f.path)).size).padStart(5)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
