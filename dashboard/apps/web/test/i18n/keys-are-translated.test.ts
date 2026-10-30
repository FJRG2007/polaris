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
const ROOTS = [join(WEB, "src"), join(WEB, "..", "..", "packages", "ui", "src")];
const MESSAGES = join(WEB, "messages", "en-US");
/** Attributes shown to a person, as children are. */
const SHOWN = new Set(["title", "aria-label", "alt", "placeholder", "label", "description"]);

type Fields = ReadonlySet<string>;

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

function parse(path: string): ts.SourceFile {
    const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
}

/** The tables in a file: each name, and the fields of it that hold a key. */
function tablesIn(source: ts.SourceFile, keys: ReadonlySet<string>): Map<string, Fields> {
    const tables = new Map<string, Fields>();
    walk(source, (node) => {
        if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
        if (!node.initializer) return;
        const fields = new Set<string>();
        walk(node.initializer, (inner) => {
            if (
                ts.isPropertyAssignment(inner) &&
                ts.isIdentifier(inner.name) &&
                ts.isStringLiteralLike(inner.initializer) &&
                keys.has(inner.initializer.text)
            )
                fields.add(inner.name.text);
        });
        if (fields.size > 0) tables.set(node.name.text, fields);
    });
    return tables;
}

/** The name a chain starts from: `TABLE` for `TABLE.filter(...).find(...)!`. */
function rootOf(node: ts.Expression): string | null {
    let at = node;
    for (;;) {
        if (ts.isIdentifier(at)) return at.text;
        if (
            ts.isCallExpression(at) ||
            ts.isNonNullExpression(at) ||
            ts.isParenthesizedExpression(at) ||
            ts.isPropertyAccessExpression(at) ||
            ts.isElementAccessExpression(at)
        )
            at = at.expression;
        else if (
            ts.isBinaryExpression(at) &&
            at.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        )
            at = at.left;
        else return null;
    }
}

/** The names in a file that stand for a table, or for a row picked out of one. */
function rowsOf(source: ts.SourceFile, tables: ReadonlyMap<string, Fields>): Map<string, Fields> {
    const rows = new Map<string, Fields>(tables);
    walk(source, (node) => {
        if (!ts.isVariableDeclaration(node) || !node.initializer) return;
        const fields = tables.get(rootOf(node.initializer) ?? "");
        if (fields && ts.isIdentifier(node.name)) rows.set(node.name.text, fields);
    });
    return rows;
}

/** The row a callback is handed, when it is called on a table. */
function rowOfCallback(
    node: ts.Node,
    tables: ReadonlyMap<string, Fields>
): { body: ts.ArrowFunction; name: string; fields: Fields } | null {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
    const fields = tables.get(rootOf(node.expression.expression) ?? "");
    const body = node.arguments[0];
    if (!fields || !body || !ts.isArrowFunction(body)) return null;
    const name = body.parameters[0]?.name;
    return name && ts.isIdentifier(name) ? { body, name: name.text, fields } : null;
}

/** A row's field written straight into the markup, with no `t` around it. */
function rawUses(source: ts.SourceFile, tables: ReadonlyMap<string, Fields>): string[] {
    const found: string[] = [];
    const check = (expression: ts.Expression | undefined, rows: ReadonlyMap<string, Fields>) => {
        if (!expression || !ts.isPropertyAccessExpression(expression)) return;
        const fields = rows.get(rootOf(expression.expression) ?? "");
        if (!fields?.has(expression.name.text)) return;
        const { line } = source.getLineAndCharacterOfPosition(expression.getStart());
        const path = relative(WEB, source.fileName).replaceAll("\\", "/");
        found.push(`${path}:${line + 1} ${expression.getText()}`);
    };
    const visit = (node: ts.Node, rows: ReadonlyMap<string, Fields>) => {
        if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) check(node.expression, rows);
        if (ts.isJsxAttribute(node) && SHOWN.has(node.name.getText())) {
            const value = node.initializer;
            if (value && ts.isJsxExpression(value)) check(value.expression, rows);
        }
        // A row's name means that row only inside its own callback: the same word
        // is free to mean something else in the next one.
        const callback = rowOfCallback(node, tables);
        ts.forEachChild(node, (child) =>
            visit(
                child,
                callback?.body === child
                    ? new Map(rows).set(callback.name, callback.fields)
                    : rows
            )
        );
    };
    visit(source, rowsOf(source, tables));
    return found;
}

function importedNames(source: ts.SourceFile): string[] {
    return source.statements.flatMap((statement) => {
        const bindings = ts.isImportDeclaration(statement)
            ? statement.importClause?.namedBindings
            : undefined;
        return bindings && ts.isNamedImports(bindings)
            ? bindings.elements.map((element) => element.name.text)
            : [];
    });
}

describe("translation keys in tables", () => {
    const files = ROOTS.flatMap(sources).map(parse);
    const keys = catalogKeys();
    const own = new Map(files.map((source) => [source, tablesIn(source, keys)]));
    const tables = new Map([...own.values()].flatMap((found) => [...found]));

    it("finds the tables", () => {
        expect(tables.get("NOISE_LEVELS")).toEqual(new Set(["label", "help"]));
    });

    it("never draws one of their keys without translating it", () => {
        const raw = files.flatMap((source) => {
            const visible = new Map(own.get(source));
            for (const name of importedNames(source)) {
                const fields = tables.get(name);
                if (fields) visible.set(name, fields);
            }
            return visible.size > 0 ? rawUses(source, visible) : [];
        });
        expect(raw).toEqual([]);
    });
});
