/**
 * Which catalog keys nothing reads.
 *
 * A key is read when the source names it: as a string literal (`t("a.b")`, a
 * `NamespaceKey` in a table, a key handed to a component), with or without its
 * namespace in front (`"chat.a.b"`), or as a template whose fixed parts fit it
 * (`t(\`levels.${level}\`)` reads every `levels.*`). The rule leans towards
 * "read": a short key that happens to equal some other string is kept, which
 * costs a stale entry, while the opposite would delete a sentence a screen
 * still draws. A key is only ever reported, never guessed at.
 */

import ts from "typescript";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

/** Quoted attribute values in markup (`data-t-title="map.zoomIn"`). */
const QUOTED = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;

export interface SourceStrings {
    /** Plain strings, without their quotes. */
    readonly literals: Set<string>;
    /** Templates with a hole, as patterns a whole key has to match. */
    readonly patterns: RegExp[];
}

function escape(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A template's fixed parts as a pattern, or null when they say too little to
 * point at any key in particular (`${a}.${b}`), which would keep everything.
 */
export function templatePattern(parts: readonly string[]): RegExp | null {
    if (parts.length === 1) return null;
    if (!/[A-Za-z]{2}/.test(parts.join(""))) return null;
    // A hole stands for anything but nothing: a segment, several, or an English
    // label used as a key (`labels.${english}` reads "labels.Wall panels").
    return new RegExp(`^${parts.map(escape).join(".+")}$`);
}

function keep(text: string, into: SourceStrings): void {
    if (text.length > 0 && text.length <= 200) into.literals.add(text);
}

/**
 * Every string and template a file writes, found by parsing it rather than by
 * pattern, so a template inside another template's hole
 * (`` `${t(`queue.results.${result}`)}` ``) is seen as the key it is.
 */
export function stringsOf(source: string, into: SourceStrings, fileName = "source.tsx"): void {
    if (fileName.endsWith(".html")) {
        for (const match of source.matchAll(QUOTED)) keep(match[0].slice(1, -1), into);
        return;
    }
    // `<T>(x) => x` in a .ts file is a generic, in a .tsx one an element: the
    // wrong kind misreads the rest of the file.
    const kind = /\.[cm]?tsx$|\.jsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
    // A file's own string constants, so `${ISSUE}.${code}` is read as the
    // prefix ISSUE holds rather than as a template that points at nothing. Only
    // a name declared once, as a `const` string: a name bound twice, or one
    // that can change, may hold anything when the template runs.
    const constants = new Map<string, string | null>();
    const collect = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            const name = node.name.text;
            const fixed = ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0;
            const value = fixed && node.initializer && ts.isStringLiteral(node.initializer) ? node.initializer.text : null;
            constants.set(name, constants.has(name) ? null : value);
        } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) constants.set(node.name.text, null);
        ts.forEachChild(node, collect);
    };
    collect(file);
    const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) keep(node.text, into);
        else if (ts.isTemplateExpression(node)) {
            const parts = [node.head.text];
            for (const span of node.templateSpans) {
                const known = ts.isIdentifier(span.expression) ? constants.get(span.expression.text) : undefined;
                if (known === undefined || known === null) parts.push(span.literal.text);
                else parts[parts.length - 1] += known + span.literal.text;
            }
            if (parts.length === 1) keep(parts[0]!, into);
            const pattern = templatePattern(parts);
            if (pattern) into.patterns.push(pattern);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
}

/** Folders that hold no source a screen runs: dependencies, build output,
 *  the catalogs themselves and the tests. */
const SKIPPED = new Set(["node_modules", "dist", "build", "out", "messages", "test", "tests", "__tests__"]);

/** Every source file under these folders, tests left out: a key only a test
 *  names is a key no screen draws. */
export function sourceStrings(roots: readonly string[]): SourceStrings {
    const into: SourceStrings = { literals: new Set(), patterns: [] };
    const walk = (folder: string) => {
        for (const entry of readdirSync(folder)) {
            if (SKIPPED.has(entry) || entry.startsWith(".")) continue;
            const path = join(folder, entry);
            if (statSync(path).isDirectory()) walk(path);
            else if (/\.(ts|tsx|mts|js|jsx|mjs|html)$/.test(entry) && !/\.(test|spec)\./.test(entry)) {
                stringsOf(readFileSync(path, "utf8"), into, entry);
            }
        }
    };
    for (const root of roots) if (existsSync(root)) walk(root);
    // The same template is written in many files; each key is tried against
    // every pattern, so each is kept once.
    const unique = new Map(into.patterns.map((pattern) => [pattern.source, pattern]));
    return { literals: into.literals, patterns: [...unique.values()] };
}

/** The dotted path of every message in a catalog. */
export function catalogKeys(catalog: unknown, prefix = ""): string[] {
    if (typeof catalog !== "object" || catalog === null) return [];
    const keys: string[] = [];
    for (const [name, value] of Object.entries(catalog)) {
        const path = prefix ? `${prefix}.${name}` : name;
        if (typeof value === "string") keys.push(path);
        else keys.push(...catalogKeys(value, path));
    }
    return keys;
}

/** Whether a string or a template in the source is this text. */
function named(text: string, strings: SourceStrings): boolean {
    return strings.literals.has(text) || strings.patterns.some((pattern) => pattern.test(text));
}

/** Whether a path is named in two halves: a scope, and the rest under it. */
function namedInHalves(path: string, strings: SourceStrings): boolean {
    const segments = path.split(".");
    for (let cut = 1; cut < segments.length; cut++) {
        const scope = segments.slice(0, cut).join(".");
        if (strings.literals.has(scope) && named(segments.slice(cut).join("."), strings)) return true;
    }
    return false;
}

/**
 * Whether the source reads this key of this namespace: named whole, or named
 * in two halves - a scope (`useTranslations("agents.session")`, or a prefix
 * kept in a constant inside the namespace) and the rest under it (`t("send")`).
 */
export function isRead(namespace: string, key: string, strings: SourceStrings): boolean {
    const full = `${namespace}.${key}`;
    if (named(key, strings) || named(full, strings)) return true;
    return namedInHalves(full, strings) || namedInHalves(key, strings);
}

/** The keys of one catalog folder (`messages/en-US`) nothing reads. */
export function unusedKeys(folder: string, strings: SourceStrings): string[] {
    const unused: string[] = [];
    for (const file of readdirSync(folder).filter((name) => name.endsWith(".json"))) {
        const namespace = file.slice(0, -".json".length);
        const catalog = JSON.parse(readFileSync(join(folder, file), "utf8")) as unknown;
        for (const key of catalogKeys(catalog)) {
            if (!isRead(namespace, key, strings)) unused.push(`${namespace}.${key}`);
        }
    }
    return unused;
}
