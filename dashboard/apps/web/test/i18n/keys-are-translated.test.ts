/**
 * A table of options can hold translation keys rather than words, so one screen
 * renders `t(level.label)` and the next can write `{level.label}`. Both compile,
 * because a key is a string and a string is something React draws, and the second
 * shows the reader `callSettings.noise.off.label`. The type system cannot tell the
 * two apart, so this does: every table whose fields hold a catalog's keys is found,
 * and none of those fields may reach the screen without going through `t`.
 */

import ts from "typescript";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UI = join(WEB, "..", "..", "packages", "ui");
const ROOTS = [join(WEB, "src"), join(UI, "src")];
const MESSAGES = join(WEB, "messages", "en-US");
/** Attributes shown to a person, as children are. */
const SHOWN = new Set(["title", "aria-label", "alt", "placeholder", "label", "description"]);
/** Array methods whose result is still rows of the same table. */
const SAME_ROWS = new Set([
    "at",
    "concat",
    "filter",
    "find",
    "findLast",
    "flat",
    "reverse",
    "slice",
    "sort",
    "toReversed",
    "toSorted"
]);

type Fields = ReadonlySet<string>;
/** What a name stands for here: a table or row, by its key fields, or `KEY` itself. */
type Scope = Map<string, Fields>;

/** A name that holds a key rather than a row, as `label` in `({ label }) => ...`. */
const KEY: Fields = new Set<string>();

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
        return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
    });
}

function flatten(value: unknown, prefix: string, into: Set<string>): void {
    if (typeof value === "string") into.add(prefix);
    else if (value && typeof value === "object")
        for (const [key, inner] of Object.entries(value))
            flatten(inner, prefix ? `${prefix}.${key}` : key, into);
}

/** Every key of every namespace, with and without the namespace in front. */
function catalogKeys(): Set<string> {
    const keys = new Set<string>();
    for (const file of readdirSync(MESSAGES).filter((name) => name.endsWith(".json"))) {
        const catalog: unknown = JSON.parse(readFileSync(join(MESSAGES, file), "utf8"));
        flatten(catalog, "", keys);
        flatten(catalog, file.replace(/\.json$/, ""), keys);
    }
    return new Set([...keys].filter((key) => key.includes(".")));
}

function parse(path: string, text = readFileSync(path, "utf8")): ts.SourceFile {
    const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
}

/** The fields of a value that hold a key, read from the literal it is built from. */
function keyFields(value: ts.Expression, keys: ReadonlySet<string>): Fields {
    const fields = new Set<string>();
    walk(value, (inner) => {
        if (
            ts.isPropertyAssignment(inner) &&
            ts.isIdentifier(inner.name) &&
            ts.isStringLiteralLike(inner.initializer) &&
            keys.has(inner.initializer.text)
        )
            fields.add(inner.name.text);
    });
    return fields;
}

/** The tables a file declares at its top level: each name, and its key fields. */
function tablesIn(source: ts.SourceFile, keys: ReadonlySet<string>): Scope {
    const tables: Scope = new Map();
    for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const { name, initializer } of statement.declarationList.declarations) {
            if (!initializer || !ts.isIdentifier(name)) continue;
            const fields = keyFields(initializer, keys);
            if (fields.size > 0) tables.set(name.text, fields);
        }
    }
    return tables;
}

/** What a chain reads from: `TABLE`'s fields for `TABLE.filter(...).find(...)!`. */
function fieldsOf(node: ts.Expression, rows: Scope): Fields | undefined {
    let at = node;
    for (;;) {
        if (ts.isIdentifier(at)) return rows.get(at.text);
        if (ts.isPropertyAccessExpression(at) && rows.has(at.getText()))
            return rows.get(at.getText());
        if (ts.isCallExpression(at)) {
            const callee = at.expression;
            if (callee.getText() === "Object.values" && at.arguments[0]) at = at.arguments[0];
            else if (ts.isIdentifier(callee)) at = callee;
            else if (ts.isPropertyAccessExpression(callee) && SAME_ROWS.has(callee.name.text))
                at = callee.expression;
            else return undefined;
        } else if (
            ts.isNonNullExpression(at) ||
            ts.isParenthesizedExpression(at) ||
            ts.isPropertyAccessExpression(at) ||
            ts.isElementAccessExpression(at) ||
            ts.isAsExpression(at) ||
            ts.isSatisfiesExpression(at)
        )
            at = at.expression;
        else if (
            ts.isBinaryExpression(at) &&
            at.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        )
            at = at.left;
        else return undefined;
    }
}

/** The parts of an expression whose value can be a key, untranslated. */
function rawKeys(node: ts.Expression, rows: Scope): ts.Expression[] {
    if (ts.isIdentifier(node)) return rows.get(node.text) === KEY ? [node] : [];
    if (ts.isPropertyAccessExpression(node))
        return fieldsOf(node.expression, rows)?.has(node.name.text) ? [node] : [];
    if (
        ts.isParenthesizedExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node)
    )
        return rawKeys(node.expression, rows);
    if (ts.isConditionalExpression(node))
        return [...rawKeys(node.whenTrue, rows), ...rawKeys(node.whenFalse, rows)];
    if (ts.isTemplateExpression(node))
        return node.templateSpans.flatMap((span) => rawKeys(span.expression, rows));
    if (ts.isBinaryExpression(node)) {
        const operator = node.operatorToken.kind;
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return rawKeys(node.right, rows);
        if (
            operator === ts.SyntaxKind.BarBarToken ||
            operator === ts.SyntaxKind.QuestionQuestionToken ||
            operator === ts.SyntaxKind.PlusToken
        )
            return [...rawKeys(node.left, rows), ...rawKeys(node.right, rows)];
    }
    return [];
}

/** Gives a declared name what it stands for, hiding any outer name it repeats. */
function bind(name: ts.BindingName, fields: Fields | undefined, rows: Scope): void {
    if (ts.isIdentifier(name)) {
        if (fields) rows.set(name.text, fields);
        else rows.delete(name.text);
        return;
    }
    for (const element of name.elements) {
        if (ts.isOmittedExpression(element)) continue;
        if (ts.isArrayBindingPattern(name) || !ts.isIdentifier(element.name))
            bind(element.name, undefined, rows);
        else if (element.dotDotDotToken) bind(element.name, fields, rows);
        else {
            const field = (element.propertyName ?? element.name).getText();
            bind(element.name, fields?.has(field) ? KEY : undefined, rows);
        }
    }
}

function declare(node: ts.VariableDeclaration, rows: Scope, keys: ReadonlySet<string>): void {
    const value = node.initializer;
    if (!value) return bind(node.name, undefined, rows);
    const own = keyFields(value, keys);
    if (own.size > 0) bind(node.name, own, rows);
    else if (rawKeys(value, rows).length > 0) bind(node.name, KEY, rows);
    else bind(node.name, fieldsOf(value, rows), rows);
}

/** The row a function is handed, when it is the callback of a call on a table. */
function fieldsOfCallback(node: ts.SignatureDeclaration, rows: Scope): Fields | undefined {
    const call = node.parent;
    if (!ts.isCallExpression(call) || call.arguments[0] !== node) return undefined;
    const callee = call.expression;
    return ts.isPropertyAccessExpression(callee) ? fieldsOf(callee.expression, rows) : undefined;
}

/**
 * A key written straight into the markup, with no `t` around it. Names follow the
 * code's own scopes, because the same word is free to mean something else in the
 * next function along.
 */
function rawUses(source: ts.SourceFile, imported: Scope, keys: ReadonlySet<string>): string[] {
    const found: string[] = [];
    const check = (expression: ts.Expression, rows: Scope) => {
        for (const raw of rawKeys(expression, rows)) {
            const { line } = source.getLineAndCharacterOfPosition(raw.getStart());
            const path = relative(WEB, source.fileName).replaceAll("\\", "/");
            found.push(`${path}:${line + 1} ${raw.getText()}`);
        }
    };
    const enter = (node: ts.Node, outer: Scope): Scope => {
        if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
            const rows = new Map(outer);
            for (const statement of node.statements)
                if (ts.isVariableStatement(statement))
                    for (const declaration of statement.declarationList.declarations)
                        declare(declaration, rows, keys);
            return rows;
        }
        if (ts.isFunctionLike(node)) {
            const rows = new Map(outer);
            const row = fieldsOfCallback(node, outer);
            node.parameters.forEach(({ name }, index) =>
                bind(name, index === 0 ? row : undefined, rows)
            );
            return rows;
        }
        if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
            const rows = new Map(outer);
            for (const { name } of node.initializer.declarations)
                bind(name, fieldsOf(node.expression, outer), rows);
            return rows;
        }
        return outer;
    };
    const visit = (node: ts.Node, outer: Scope) => {
        const rows = enter(node, outer);
        if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent) && node.expression)
            check(node.expression, rows);
        if (ts.isJsxAttribute(node) && SHOWN.has(node.name.getText())) {
            const value = node.initializer;
            if (value && ts.isJsxExpression(value) && value.expression)
                check(value.expression, rows);
        }
        if (ts.isObjectLiteralExpression(node) && ts.findAncestor(node, ts.isJsxAttribute))
            for (const property of node.properties) {
                if (!property.name || !SHOWN.has(property.name.getText())) continue;
                if (ts.isPropertyAssignment(property)) check(property.initializer, rows);
                if (ts.isShorthandPropertyAssignment(property)) check(property.name, rows);
            }
        ts.forEachChild(node, (child) => visit(child, rows));
    };
    visit(source, imported);
    return found;
}

/** The scanned file a module specifier names, if it names one. */
function resolveModule(from: string, specifier: string, known: ReadonlySet<string>): string | null {
    let base: string | undefined;
    if (specifier.startsWith("@/")) base = join(WEB, "src", specifier.slice(2));
    else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
    else if (specifier === "@polaris/ui" || specifier.startsWith("@polaris/ui/")) {
        const { exports } = JSON.parse(readFileSync(join(UI, "package.json"), "utf8")) as {
            exports: Record<string, string | { import: string }>;
        };
        const entry = exports[`.${specifier.slice("@polaris/ui".length)}`];
        if (entry) base = join(UI, typeof entry === "string" ? entry : entry.import);
    }
    if (!base) return null;
    for (const end of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        const path = resolve(`${base}${end}`);
        if (known.has(path)) return path;
    }
    return null;
}

function specifierOf(node: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
    const specifier = node.moduleSpecifier;
    return specifier && ts.isStringLiteralLike(specifier) ? specifier.text : null;
}

/** Scans a set of files, each seeing the tables its own imports bring in. */
function scan(files: ts.SourceFile[], keys: ReadonlySet<string>): string[] {
    const byPath = new Map(files.map((source) => [resolve(source.fileName), source]));
    const known = new Set(byPath.keys());
    const exported = new Map<string, Scope>();

    /** A module's tables under their exported names, re-exports followed. */
    const tablesOf = (path: string): Scope => {
        const seen = exported.get(path);
        if (seen) return seen;
        const source = byPath.get(path);
        const tables = source ? tablesIn(source, keys) : new Map<string, Fields>();
        exported.set(path, tables);
        for (const statement of source?.statements ?? []) {
            if (!ts.isExportDeclaration(statement)) continue;
            const specifier = specifierOf(statement);
            const target = specifier ? resolveModule(path, specifier, known) : null;
            const from = target ? tablesOf(target) : specifier ? new Map<string, Fields>() : tables;
            const clause = statement.exportClause;
            if (!clause) for (const [name, fields] of from) tables.set(name, fields);
            else if (ts.isNamedExports(clause))
                for (const element of clause.elements) {
                    const fields = from.get((element.propertyName ?? element.name).text);
                    if (fields) tables.set(element.name.text, fields);
                }
        }
        return tables;
    };

    const importsOf = (source: ts.SourceFile): Scope => {
        const scope: Scope = new Map();
        for (const statement of source.statements) {
            if (!ts.isImportDeclaration(statement)) continue;
            const specifier = specifierOf(statement);
            const target = specifier && resolveModule(resolve(source.fileName), specifier, known);
            const bindings = statement.importClause?.namedBindings;
            if (!target || !bindings) continue;
            const tables = tablesOf(target);
            if (ts.isNamespaceImport(bindings))
                for (const [name, fields] of tables)
                    scope.set(`${bindings.name.text}.${name}`, fields);
            else
                for (const element of bindings.elements) {
                    const fields = tables.get((element.propertyName ?? element.name).text);
                    if (fields) scope.set(element.name.text, fields);
                }
        }
        return scope;
    };

    return files.flatMap((source) => rawUses(source, importsOf(source), keys));
}

/** Scans made-up modules, keyed by their path under `src`, with one key in the catalog. */
function scanFixture(modules: Record<string, string>): string[] {
    const files = Object.entries(modules).map(([name, text]) =>
        parse(join(WEB, "src", name), text)
    );
    return scan(files, new Set(["a.b"])).map((use) => use.replace(/^.*?:\d+ /, ""));
}

const TABLE = `const TABLE = [{ value: "off", label: "a.b" }];`;
const USE = (name: string) => `${name}.map((row) => <b>{row.label}</b>)`;

describe("the scan for untranslated keys", () => {
    it.each([
        ["a row in a callback", USE("TABLE"), "row.label"],
        ["a row picked out", "const row = TABLE[0]; <b>{row.label}</b>", "row.label"],
        ["a shown attribute", "TABLE.map((row) => <b title={row.label} />)", "row.label"],
        ["a loop", "for (const row of TABLE) <b>{row.label}</b>", "row.label"],
        ["a record", "Object.values(TABLE).map((row) => <b>{row.label}</b>)", "row.label"],
        [
            "a table narrowed first",
            `const shown = TABLE.filter(Boolean); ${USE("shown")}`,
            "row.label"
        ],
        ["a destructured row", "TABLE.map(({ label }) => <b>{label}</b>)", "label"],
        ["a renamed field", "TABLE.map(({ label: name }) => <b>{name}</b>)", "name"],
        ["a field read out", "const { label } = TABLE[0]; <b>{label}</b>", "label"],
        ["a field copied", "const name = TABLE[0].label; <b>{name}</b>", "name"],
        ["a condition", "TABLE.map((row) => <b>{on ? row.label : null}</b>)", "row.label"],
        ["a guard", "TABLE.map((row) => <b>{on && row.label}</b>)", "row.label"],
        ["a fallback", "TABLE.map((row) => <b>{row.label ?? other}</b>)", "row.label"],
        ["a template", "TABLE.map((row) => <b>{`${row.label}: x`}</b>)", "row.label"],
        [
            "a key copied into options",
            "<Pick options={TABLE.map((one) => ({ value: one.value, label: one.label }))} />",
            "one.label"
        ],
        [
            "a shorthand copied into options",
            "<Pick options={TABLE.map(({ label }) => ({ label }))} />",
            "label"
        ]
    ])("flags %s", (_, code, use) => {
        expect(scanFixture({ "a.tsx": `${TABLE}\n${code}` })).toEqual([use]);
    });

    it.each([
        ["a translated field", "TABLE.map((row) => <b>{t(row.label)}</b>)"],
        ["a field that holds no key", "TABLE.map((row) => <b>{row.value}</b>)"],
        ["a destructured field translated", "TABLE.map(({ label }) => <b>{t(label)}</b>)"],
        ["translated options", "<Pick options={TABLE.map((one) => ({ label: t(one.label) }))} />"],
        [
            "a table mapped to words",
            "const words = TABLE.map((row) => ({ label: t(row.label) })); words.map((w) => <b>{w.label}</b>)"
        ],
        ["a name reused by another callback", USE("other")],
        ["a parameter hiding a row", `const row = TABLE[0]; ${USE("other")}`],
        [
            "a local hiding a row",
            "const row = TABLE[0]; function f() { const row = other; return <b>{row.label}</b>; }"
        ],
        ["a key kept out of shown places", "<Pick value={TABLE[0].label} />"]
    ])("leaves %s alone", (_, code) => {
        expect(scanFixture({ "a.tsx": `${TABLE}\n${code}` })).toEqual([]);
    });

    it.each([
        ["by name", `import { TABLE } from "./table";`, "TABLE"],
        ["under another name", `import { TABLE as ROWS } from "./table";`, "ROWS"],
        ["through a namespace", `import * as tables from "./table";`, "tables.TABLE"],
        ["through the alias", `import { TABLE } from "@/table";`, "TABLE"]
    ])("follows an import %s", (_, line, name) => {
        const modules = { "table.ts": `export ${TABLE}`, "a.tsx": `${line}\n${USE(name)}` };
        expect(scanFixture(modules)).toEqual(["row.label"]);
    });

    it("follows a re-export", () => {
        expect(
            scanFixture({
                "table.ts": `export ${TABLE}`,
                "index.ts": `export { TABLE as ROWS } from "./table";`,
                "a.tsx": `import { ROWS } from "./index";\n${USE("ROWS")}`
            })
        ).toEqual(["row.label"]);
    });

    it("does not mistake one module's table for another of the same name", () => {
        expect(
            scanFixture({
                "table.ts": `export ${TABLE}`,
                "other.ts": `export const TABLE = [{ label: "words" }];`,
                "a.tsx": `import { TABLE } from "./other";\n${USE("TABLE")}`
            })
        ).toEqual([]);
    });
});

describe("translation keys in tables", () => {
    const files = ROOTS.flatMap(sources).map((path) => parse(path));
    const keys = catalogKeys();

    it("finds the tables", () => {
        const levels = files.find((source) => tablesIn(source, keys).has("NOISE_LEVELS"));
        expect(levels && tablesIn(levels, keys).get("NOISE_LEVELS")).toEqual(
            new Set(["label", "help"])
        );
    });

    it("never draws one of their keys without translating it", () => {
        expect(scan(files, keys)).toEqual([]);
    });
});
