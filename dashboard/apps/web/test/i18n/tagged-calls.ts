/**
 * Finds the call sites that would print a message's tags as text.
 *
 * A message with a tag in it (`Last active <time></time>`, `<b>{name}</b>`) only
 * formats through `t.rich`, and only when every tag is given a function - the
 * formatter throws on anything else, and the translator answers a failure with
 * the raw message, markup included. So `t("key")` on a tagged message, or
 * `t.rich("key", { time: <RelativeTime /> })`, reaches the reader as
 * `Last active <time></time>` and nothing at build time says so.
 *
 * Which namespace a call reads is resolved from the file: the translator it is
 * called on was bound by a call that named the namespace
 * (`useTranslations("components")`, `translatorFor(locale, "admin")`,
 * `gameCatalogs.translator(locale, "games")`), or is a parameter whose type names
 * it (`NamespaceTranslator<"components">`). Where neither says, every namespace
 * holding the key is a candidate, and a key no namespace holds is not a call to
 * a translator at all.
 */

import ts from "typescript";
import { join, relative } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { flattenCatalog, inspectMessage, type Catalog } from "@polaris/core";

/** One namespace: each key and the tags its message uses. */
export type TagIndex = ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;

export interface TaggedCallFinding {
    readonly file: string;
    readonly line: number;
    readonly key: string;
    readonly namespace: string;
    readonly problem: string;
}

/** The tags of every message in one locale's folder of catalogs, by namespace. */
export function indexCatalogFolder(
    folder: string,
    into = new Map<string, Map<string, readonly string[]>>()
) {
    if (!existsSync(folder)) return into;
    for (const file of readdirSync(folder).filter((name) => name.endsWith(".json"))) {
        const namespace = file.slice(0, -".json".length);
        const catalog = JSON.parse(readFileSync(join(folder, file), "utf8")) as Catalog;
        into.set(namespace, indexCatalog(catalog));
    }
    return into;
}

/** The tags of every message in one catalog. */
export function indexCatalog(catalog: Catalog): Map<string, readonly string[]> {
    const keys = new Map<string, readonly string[]>();
    for (const [key, message] of flattenCatalog(catalog)) {
        const inspected = inspectMessage("en-US", message);
        keys.set(key, inspected.ok ? inspected.tags : []);
    }
    return keys;
}

/** Every .ts and .tsx file under a folder, tests and declarations left out. */
export function sourceFiles(root: string): string[] {
    const found: string[] = [];
    const walk = (folder: string) => {
        for (const entry of readdirSync(folder)) {
            if (entry === "node_modules" || entry.startsWith(".")) continue;
            const path = join(folder, entry);
            if (statSync(path).isDirectory()) walk(path);
            else if (/\.tsx?$/.test(entry) && !/\.d\.ts$|\.test\.tsx?$/.test(entry))
                found.push(path);
        }
    };
    walk(root);
    return found;
}

function unwrap(node: ts.Expression): ts.Expression {
    let current = node;
    while (
        ts.isParenthesizedExpression(current) ||
        ts.isAwaitExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isSatisfiesExpression(current)
    )
        current = current.expression;
    return current;
}

/** The namespace a call names among its arguments, the last one that is one. */
function namespaceArgument(call: ts.CallExpression, index: TagIndex): string | undefined {
    let named: string | undefined;
    for (const argument of call.arguments) {
        const value = unwrap(argument);
        if (ts.isStringLiteralLike(value) && index.has(value.text)) named = value.text;
    }
    return named;
}

/** The namespaces a type annotation names: `NamespaceTranslator<"components">`. */
function namespacesInType(type: ts.TypeNode, index: TagIndex): string[] {
    const named: string[] = [];
    const visit = (node: ts.Node) => {
        if (
            ts.isLiteralTypeNode(node) &&
            ts.isStringLiteral(node.literal) &&
            index.has(node.literal.text)
        )
            named.push(node.literal.text);
        ts.forEachChild(node, visit);
    };
    visit(type);
    return named;
}

/** Which namespace each translator name in a file was bound to. */
function bindings(file: ts.SourceFile, index: TagIndex): Map<string, Set<string>> {
    const bound = new Map<string, Set<string>>();
    const bind = (name: string, namespace: string) => {
        const set = bound.get(name) ?? new Set<string>();
        set.add(namespace);
        bound.set(name, set);
    };
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            const value = unwrap(node.initializer);
            if (ts.isCallExpression(value)) {
                const namespace = namespaceArgument(value, index);
                if (namespace) bind(node.name.text, namespace);
            }
            if (node.type)
                for (const namespace of namespacesInType(node.type, index))
                    bind(node.name.text, namespace);
        }
        if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type) {
            for (const namespace of namespacesInType(node.type, index))
                bind(node.name.text, namespace);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return bound;
}

/** What each `const` in a file was set to, scopes ignored: a name declared twice
 *  keeps neither, since which one a call sees is not known from here. */
function constantsOf(file: ts.SourceFile): Map<string, ts.Expression> {
    const found = new Map<string, ts.Expression>();
    const twice = new Set<string>();
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            if (found.has(node.name.text)) twice.add(node.name.text);
            found.set(node.name.text, unwrap(node.initializer));
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    for (const name of twice) found.delete(name);
    return found;
}

/** The keys a first argument can be: itself, or every key a template matches. */
function keysOf(argument: ts.Expression, keys: ReadonlyMap<string, readonly string[]>): string[] {
    const value = unwrap(argument);
    if (ts.isStringLiteralLike(value)) return keys.has(value.text) ? [value.text] : [];
    if (ts.isTemplateExpression(value)) {
        const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(
            `^${escape(value.head.text)}${value.templateSpans.map((span) => `[^.]+${escape(span.literal.text)}`).join("")}$`
        );
        return [...keys.keys()].filter((key) => pattern.test(key));
    }
    return [];
}

/** What is wrong with the value given for one tag, if anything. */
function tagProblem(
    params: ts.Expression | undefined,
    tag: string,
    constants: ReadonlyMap<string, ts.Expression>
): string | null {
    const value = params ? unwrap(params) : undefined;
    if (!value || !ts.isObjectLiteralExpression(value)) {
        // Built elsewhere: what it holds is not visible from here.
        return value ? null : `<${tag}> is given nothing`;
    }
    const property = value.properties.find(
        (entry) =>
            (ts.isPropertyAssignment(entry) ||
                ts.isShorthandPropertyAssignment(entry) ||
                ts.isMethodDeclaration(entry)) &&
            entry.name !== undefined &&
            (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
            entry.name.text === tag
    );
    if (!property) {
        return value.properties.some(ts.isSpreadAssignment) ? null : `<${tag}> is given nothing`;
    }
    if (ts.isMethodDeclaration(property)) return null;
    let given: ts.Expression = ts.isPropertyAssignment(property)
        ? unwrap(property.initializer)
        : property.name;
    // A constant of the same file is judged by what it was set to.
    if (ts.isIdentifier(given)) given = constants.get(given.text) ?? given;
    if (ts.isArrowFunction(given) || ts.isFunctionExpression(given)) return null;
    if (
        ts.isJsxElement(given) ||
        ts.isJsxSelfClosingElement(given) ||
        ts.isJsxFragment(given) ||
        ts.isStringLiteralLike(given) ||
        ts.isTemplateExpression(given) ||
        ts.isNumericLiteral(given) ||
        given.kind === ts.SyntaxKind.NullKeyword ||
        given.kind === ts.SyntaxKind.TrueKeyword ||
        given.kind === ts.SyntaxKind.FalseKeyword
    )
        return `<${tag}> is given a value instead of a function`;
    return null;
}

/**
 * What is wrong with one call. With its namespace resolved, that namespace's
 * message decides; without it, a key is judged only when every namespace holding
 * it agrees, so a key two namespaces share is not blamed on the one it was never
 * read from.
 */
function judgeCall(
    call: ts.CallExpression,
    rich: boolean,
    namespaces: string[] | undefined,
    onName: boolean,
    index: TagIndex,
    constants: ReadonlyMap<string, ts.Expression>,
    file: string,
    line: number
): TaggedCallFinding[] {
    // On a name nothing bound, only a literal dotted path is taken for a key: a
    // template could be anybody's, and a bare word ("port") is as likely a form
    // field's name handed to a helper as it is a message.
    if (!namespaces) {
        const key = unwrap(call.arguments[0]);
        if (!onName || !ts.isStringLiteralLike(key) || !key.text.includes(".")) return [];
    }
    const perKey: TaggedCallFinding[][] = [];
    for (const namespace of namespaces ?? [...index.keys()]) {
        const keys = index.get(namespace);
        if (!keys) continue;
        for (const key of keysOf(call.arguments[0], keys)) {
            const tags = keys.get(key) ?? [];
            const at = { file, line, key, namespace };
            if (!rich) {
                perKey.push(
                    tags.length > 0
                        ? [
                              {
                                  ...at,
                                  problem: `has tags (${tags.join(", ")}) but is formatted with plain t()`
                              }
                          ]
                        : []
                );
                continue;
            }
            perKey.push(
                tags.flatMap((tag) => {
                    const problem = tagProblem(call.arguments[1], tag, constants);
                    return problem ? [{ ...at, problem }] : [];
                })
            );
        }
    }
    // A template names a family of keys, and the code around it usually narrows
    // which ones it can be (`state.${state}` beside a `state.onlineBody` read
    // elsewhere), so it is blamed only when every key it can reach is wrong.
    const agreed = perKey.length > 0 && perKey.every((found) => found.length > 0);
    if (ts.isTemplateExpression(unwrap(call.arguments[0]))) return agreed ? perKey.flat() : [];
    if (namespaces) return perKey.flat();
    return agreed ? perKey[0] : [];
}

/** The translator call sites in one file that would print a tag as text. */
export function scanSource(
    path: string,
    source: string,
    index: TagIndex,
    label = path
): TaggedCallFinding[] {
    const file = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const bound = bindings(file, index);
    const constants = constantsOf(file);
    const findings: TaggedCallFinding[] = [];

    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.arguments.length > 0) {
            let callee = unwrap(node.expression);
            let rich = false;
            if (ts.isPropertyAccessExpression(callee) && callee.name.text === "rich") {
                rich = true;
                callee = unwrap(callee.expression);
            }
            let namespaces: string[] | undefined;
            if (ts.isIdentifier(callee)) {
                const names = bound.get(callee.text);
                if (names) namespaces = [...names];
            } else if (ts.isCallExpression(callee)) {
                const named = namespaceArgument(callee, index);
                if (named) namespaces = [named];
            }
            const { line } = file.getLineAndCharacterOfPosition(node.getStart());
            findings.push(
                ...judgeCall(
                    node,
                    rich,
                    namespaces,
                    ts.isIdentifier(callee),
                    index,
                    constants,
                    label,
                    line + 1
                )
            );
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return findings;
}

/** Every finding under a source folder, with paths relative to `base`. */
export function scanFolder(root: string, index: TagIndex, base: string): TaggedCallFinding[] {
    return sourceFiles(root).flatMap((path) =>
        scanSource(
            path,
            readFileSync(path, "utf8"),
            index,
            relative(base, path).replace(/\\/g, "/")
        )
    );
}
