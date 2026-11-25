/**
 * Every namespace a client screen translates with reaches the browser.
 *
 * `useTranslations("ns")` in a client component reads only what a `<Messages
 * namespaces={[...]}>` above it handed down; a namespace nobody handed down is
 * not an error anywhere, it is the key itself printed on the screen. That is how
 * Agent rollouts and the Deploy registries shipped reading
 * "agentRollouts.rollout.heading": the catalogs had every string, and no route
 * gave them to the page.
 *
 * So for each file under `src/app` and `src/components`, the namespaces it uses
 * must be provided on every route that renders it: by the root layout, the app
 * shell, or a `<Messages>` on that route or an ancestor of it. A route file
 * (page, layout, ...) renders on its own folder; any other file renders wherever
 * the files importing it do, followed back through the imports.
 *
 * A provider that is not a route file covers only what is drawn inside its
 * element. The check used to count a `ClientMessages` for everything its file
 * imported, and Polar Code's Switch agent dialog shipped reading
 * "agents.session.switch.title" (BUG-0037): polar-code.tsx wraps its session
 * tools in `ClientMessages namespaces={["agents"]}` and draws CodeAgentSwitch
 * and CodeAccountSwitch outside it. So an import is followed past a provider
 * only when every place the file uses it sits inside that provider - parsed,
 * not matched - and a dynamic import by the name its `.then` binds.
 */

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const WEB = resolve(__dirname, "../..");
const SRC = join(WEB, "src");
const APP = join(SRC, "app");
const SHELL_ROUTE = join(APP, "(app)");

/** What the root layout gives every screen. */
const ROOT = ["common", "components"];

const ROUTE_FILE = /^(page|layout|template|loading|error|not-found|default|global-error)\.tsx?$/;

/** What the app shell gives every screen under (app): read from the shell
 *  itself, so a namespace added there is never reported missing and one taken
 *  out of it is. */
const SHELL = provided(readFileSync(join(SRC, "components", "app-chrome.tsx"), "utf8"));

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return files(path);
        return /\.tsx?$/.test(entry) ? [path] : [];
    });
}

function provided(source: string): string[] {
    return [...source.matchAll(/namespaces=\{\[([^\]]*)\]\}/g)].flatMap((match) =>
        [...match[1]!.matchAll(/"([^"]+)"/g)].map((name) => name[1]!)
    );
}

/** Imports that can draw something: a component, a hook, a default or a
 *  whole-module import, a re-export, or a dynamic import. A plain helper or a
 *  type pulled out of a screen's file does not render that screen's words -
 *  unless it is a function of a module that draws (`.tsx`), which can hand
 *  back that module's elements: the connections hub builds its sections with
 *  `hubCoreSections()`, and Tasks' trackers printed their keys there. */
function renderedImports(source: string, from: string): string[] {
    const found: string[] = [];
    for (const match of source.matchAll(/^\s*import\s+(type\s+)?([^"';]*?)\s*from\s*"([^"]+)"/gm)) {
        if (match[1]) continue;
        const clause = match[2]!;
        const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
        const outside = clause
            .replace(/\{[^}]*\}/, "")
            .replace(/,/g, "")
            .trim();
        const draws = named
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part && !part.startsWith("type "))
            .some((part) => /^([A-Z]|use[A-Z])/.test(part.split(/\s+as\s+/)[0]!));
        const builds =
            named.trim().length > 0 && !!resolveImport(from, match[3]!)?.endsWith(".tsx");
        if (outside || draws || builds) found.push(match[3]!);
    }
    for (const match of source.matchAll(/^\s*export\s+(?!type\b)[^"';]*?\s*from\s*"([^"]+)"/gm)) {
        found.push(match[1]!);
    }
    for (const match of source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) found.push(match[1]!);
    return found;
}

function code(source: string): string {
    return source.replace(/^\s*(\/\/|\/\*|\*).*$/gm, "");
}

function used(source: string): string[] {
    const names = [...source.matchAll(/useTranslations\(\s*"([^"]+)"/g)].map(
        (match) => match[1]!.split(".")[0]!
    );
    return [...new Set(names)];
}

function resolveImport(from: string, specifier: string): string | undefined {
    const base = specifier.startsWith("@/")
        ? join(SRC, specifier.slice(2))
        : specifier.startsWith(".")
          ? resolve(dirname(from), specifier)
          : undefined;
    if (!base) return undefined;
    const candidates = [
        base,
        `${base}.tsx`,
        `${base}.ts`,
        join(base, "index.tsx"),
        join(base, "index.ts")
    ];
    return candidates.find((path) => existsSync(path) && statSync(path).isFile());
}

function within(dir: string, ancestor: string): boolean {
    return dir === ancestor || dir.startsWith(ancestor + sep);
}

/** The tag names that hand namespaces down to what they wrap. */
const PROVIDER_TAG = /(^|\.)(Messages|ClientMessages|MessagesProvider)$/;

interface Edge {
    readonly to: string;
    /** The namespaces every use of this import sits inside a provider of. */
    readonly covers: ReadonlySet<string>;
    /** For an import of hooks alone: the namespaces those hooks translate with.
     *  A hook draws none of its module's components, so the walk stops there. */
    readonly hooks?: readonly string[];
}

/** Hooks that come from React or Next and translate nothing. */
const FRAMEWORK = new Set(["react", "next/navigation", "next/dynamic", "react-dom"]);

/**
 * The namespaces a module's hooks translate with, when they are read from the
 * hooks' own bodies alone - undefined when one of them calls a hook imported
 * from elsewhere in the project, which could translate anything, so the whole
 * module has to be walked instead.
 */
function hookNamespaces(path: string, source: string, names: readonly string[]): string[] | undefined {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imported = new Set<string>();
    for (const statement of file.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        if (FRAMEWORK.has(statement.moduleSpecifier.text)) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
            for (const element of bindings.elements) imported.add(element.name.text);
        if (statement.importClause?.name) imported.add(statement.importClause.name.text);
    }
    const bodies = new Map<string, string>();
    for (const statement of file.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name)
            bodies.set(statement.name.text, statement.getText(file));
        if (ts.isVariableStatement(statement))
            for (const declaration of statement.declarationList.declarations)
                if (ts.isIdentifier(declaration.name)) bodies.set(declaration.name.text, declaration.getText(file));
    }
    const found = new Set<string>();
    const pending = [...names];
    for (const read = new Set<string>(); pending.length > 0; ) {
        const name = pending.pop()!;
        if (read.has(name)) continue;
        read.add(name);
        const body = bodies.get(name);
        if (body === undefined) return undefined;
        for (const namespace of used(code(body))) found.add(namespace);
        for (const call of body.matchAll(/b(use[A-Z]\w*)\s*[(<]/g)) {
            const hook = call[1]!;
            if (hook === name || hook === "useTranslations") continue;
            if (imported.has(hook)) return undefined;
            if (bodies.has(hook)) pending.push(hook);
        }
    }
    return [...found];
}

/** The namespaces a provider element hands down, or none for any other element. */
function elementNamespaces(node: ts.Node, file: ts.SourceFile): string[] {
    if (!ts.isJsxElement(node)) return [];
    const opening = node.openingElement;
    if (!PROVIDER_TAG.test(opening.tagName.getText(file))) return [];
    for (const attribute of opening.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || attribute.name.getText(file) !== "namespaces") continue;
        const value = attribute.initializer;
        const array = value && ts.isJsxExpression(value) ? value.expression : undefined;
        if (!array || !ts.isArrayLiteralExpression(array)) return [];
        return array.elements.filter(ts.isStringLiteral).map((element) => element.text);
    }
    return [];
}

function isDeclarationName(node: ts.Identifier): boolean {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
    return (
        (ts.isVariableDeclaration(parent) ||
            ts.isFunctionDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isBindingElement(parent) ||
            ts.isPropertyAssignment(parent) ||
            ts.isJsxAttribute(parent)) &&
        parent.name === node
    );
}

/**
 * For one file: where its providers are, and for an import, the namespaces
 * every place the file uses it sits inside.
 */
function coverage(path: string, source: string) {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const providers: { start: number; end: number; names: string[]; }[] = [];
    const references: ts.Identifier[] = [];
    const dynamics: ts.CallExpression[] = [];
    const visit = (node: ts.Node, inType: boolean) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
        const names = elementNamespaces(node, file);
        if (names.length > 0) providers.push({ start: node.getStart(file), end: node.end, names });
        if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0])
        )
            dynamics.push(node);
        if (ts.isIdentifier(node) && !inType && !isDeclarationName(node)) references.push(node);
        node.forEachChild((child) => visit(child, inType || ts.isTypeNode(node)));
    };
    visit(file, false);

    /** The namespaces every one of these places is wrapped in. */
    const around = (nodes: readonly ts.Node[]): Set<string> => {
        let common: Set<string> | undefined;
        for (const node of nodes) {
            const at = node.getStart(file);
            const here = new Set(
                providers
                    .filter((provider) => provider.start <= at && at < provider.end)
                    .flatMap((provider) => provider.names)
            );
            common = common ? new Set([...common].filter((name) => here.has(name))) : here;
        }
        return common ?? new Set();
    };

    // What a provider wraps can be built before it: the shell assembles its frame
    // in a constant and puts it inside `<Messages>` at the end, and a screen
    // draws a component of its own file inside a `ClientMessages`. A local
    // constant or function whose every use is inside a provider is inside it too.
    const candidates: { name: string; node: ts.Node }[] = [];
    const declared = (node: ts.Node) => {
        if (ts.isFunctionDeclaration(node) && node.name) candidates.push({ name: node.name.text, node });
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
            candidates.push({ name: node.name.text, node });
        node.forEachChild(declared);
    };
    if (providers.length > 0) declared(file);
    for (let pass = 0, grew = providers.length > 0; grew && pass < 6; pass++) {
        grew = false;
        for (const local of candidates) {
            const places = references.filter(
                (reference) =>
                    reference.text === local.name &&
                    !(reference.pos >= local.node.pos && reference.end <= local.node.end)
            );
            if (places.length === 0) continue;
            const names = [...around(places)];
            const start = local.node.getStart(file);
            const known = providers.find((provider) => provider.start === start && provider.end === local.node.end);
            if (names.length === 0 || (known && names.every((name) => known.names.includes(name)))) continue;
            providers.push({ start, end: local.node.end, names });
            grew = true;
        }
    }

    const uses = (name: string, inside: ts.Node = file, except?: ts.Node) =>
        references.filter(
            (reference) =>
                reference.text === name &&
                reference.pos >= inside.pos &&
                reference.end <= inside.end &&
                !(except && reference.pos >= except.pos && reference.end <= except.end)
        );

    /** A static import is used wherever the names it binds are; a component or a
     *  hook is what draws, so a helper of the same module used elsewhere does not
     *  count against it. */
    const staticCovers = (names: readonly string[]): Set<string> => {
        const drawing = names.filter((name) => /^([A-Z]|use[A-Z])/.test(name));
        const places = (drawing.length > 0 ? drawing : names).flatMap((name) => uses(name));
        return places.length === 0 ? new Set() : around(places);
    };

    /** A dynamic import is used where the name its `.then` binds is: inside
     *  that callback, or - when the callback only hands the component back, as
     *  `dynamic(() => import(...).then(...))` does - wherever the constant it is
     *  assigned to is drawn. */
    const dynamicCovers = (call: ts.CallExpression): Set<string> => {
        let holder: ts.Node = call;
        let index: number | undefined;
        if (ts.isArrayLiteralExpression(call.parent)) {
            index = call.parent.elements.indexOf(call);
            holder = call.parent.parent;
        }
        const then = holder.parent;
        const callback =
            then && ts.isPropertyAccessExpression(then) && then.name.text === "then"
                ? (then.parent as ts.CallExpression).arguments?.[0]
                : undefined;
        let bound: string | undefined;
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
            const parameter = callback.parameters[0]?.name;
            if (parameter && index === undefined && ts.isIdentifier(parameter)) bound = parameter.text;
            if (parameter && index !== undefined && ts.isArrayBindingPattern(parameter)) {
                const element = parameter.elements[index];
                if (element && ts.isBindingElement(element) && ts.isIdentifier(element.name))
                    bound = element.name.text;
            }
        }
        const inside = bound && callback ? uses(bound, callback) : [];
        const wrapped = inside.length > 0 ? around(inside) : new Set<string>();
        if (wrapped.size > 0) return wrapped;
        let declaration: ts.Node | undefined = call;
        while (declaration && !ts.isVariableDeclaration(declaration)) declaration = declaration.parent;
        if (declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
            const places = uses(declaration.name.text, file, declaration);
            if (places.length > 0) return around(places);
        }
        return around([call]);
    };

    return { file, staticCovers, dynamicCovers, dynamics };
}

/** Every import of a file that can draw, with what each one is wrapped in. */
function edges(path: string, raw: string, sources: ReadonlyMap<string, string>): Edge[] {
    const wanted = new Set(renderedImports(code(raw), path));
    const found: Edge[] = [];
    const { file, staticCovers, dynamicCovers, dynamics } = coverage(path, raw);
    const push = (specifier: string, covers: Set<string>) => {
        const to = resolveImport(path, specifier);
        if (to && to !== path) found.push({ to, covers });
    };
    for (const statement of file.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
            const specifier = statement.moduleSpecifier.text;
            const clause = statement.importClause;
            if (!wanted.has(specifier) || clause?.isTypeOnly) continue;
            const names: string[] = [];
            if (clause?.name) names.push(clause.name.text);
            const bindings = clause?.namedBindings;
            if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
            if (bindings && ts.isNamedImports(bindings))
                for (const element of bindings.elements)
                    if (!element.isTypeOnly) names.push(element.name.text);
            const to = resolveImport(path, specifier);
            const target = to && to !== path ? sources.get(to) : undefined;
            const hooks =
                target !== undefined && names.length > 0 && names.every((name) => /^use[A-Z]/.test(name))
                    ? hookNamespaces(to!, target, names)
                    : undefined;
            if (hooks) found.push({ to: to!, covers: staticCovers(names), hooks });
            else push(specifier, staticCovers(names));
        } else if (
            ts.isExportDeclaration(statement) &&
            !statement.isTypeOnly &&
            statement.moduleSpecifier &&
            ts.isStringLiteral(statement.moduleSpecifier)
        ) {
            push(statement.moduleSpecifier.text, new Set());
        }
    }
    for (const call of dynamics) {
        const specifier = (call.arguments[0] as ts.StringLiteral).text;
        if (wanted.has(specifier)) push(specifier, dynamicCovers(call));
    }
    return found;
}

const isRoute = (path: string) => within(path, APP) && ROUTE_FILE.test(basename(path));

/**
 * For each namespace a client file uses, walk the imports from every route the
 * root, the shell or a route-level `<Messages>` does not hand it to - never past
 * a provider of it, never into another route file. A file reached that uses the
 * namespace prints its keys there.
 */
function missingNamespaces(
    sources: ReadonlyMap<string, string>,
    graph: ReadonlyMap<string, readonly Edge[]>
): string[] {
    const all = [...sources.keys()];
    const routeProviders = all
        .filter(isRoute)
        .map((path) => ({ dir: dirname(path), names: provided(code(sources.get(path)!)) }))
        .filter((entry) => entry.names.length > 0);
    const given = (dir: string) =>
        new Set([
            ...ROOT,
            ...(within(dir, SHELL_ROUTE) ? SHELL : []),
            ...routeProviders.filter((entry) => within(dir, entry.dir)).flatMap((entry) => entry.names)
        ]);
    const usedBy = new Map(all.map((path) => [path, used(code(sources.get(path)!))]));
    const checked = (path: string) => within(path, APP) || within(path, join(SRC, "components"));

    // A file under app/ that no route reaches still renders on its own folder,
    // and draws nothing anywhere else.
    const starts = all.filter(isRoute);
    const reached = new Set<string>();
    for (const stack = [...starts]; stack.length > 0; ) {
        const path = stack.pop()!;
        if (reached.has(path)) continue;
        reached.add(path);
        for (const edge of graph.get(path) ?? []) if (!isRoute(edge.to)) stack.push(edge.to);
    }
    const alone = all.filter((path) => within(path, APP) && !reached.has(path));

    const missing: string[] = [];
    for (const namespace of new Set([...usedBy.values()].flat())) {
        const seen = new Map<string, string>();
        const bare = (path: string) => !given(dirname(path)).has(namespace);
        for (const path of alone.filter(bare)) seen.set(path, dirname(path));
        const from = new Map<string, string>();
        const stack: [string, string, string?][] = starts.filter(bare).map((path) => [path, dirname(path)]);
        while (stack.length > 0) {
            const [path, route, parent] = stack.pop()!;
            if (seen.has(path)) continue;
            seen.set(path, route);
            if (parent) from.set(path, parent);
            for (const edge of graph.get(path) ?? []) {
                if (isRoute(edge.to) || edge.covers.has(namespace)) continue;
                if (!edge.hooks) stack.push([edge.to, route, path]);
                else if (edge.hooks.includes(namespace) && !seen.has(edge.to)) {
                    seen.set(edge.to, route);
                    from.set(edge.to, path);
                }
            }
        }
        /** The imports that bring a file onto the route, for whoever fixes it. */
        const via = (path: string) => {
            const chain: string[] = [];
            for (let at = from.get(path); at && chain.length < 12; at = from.get(at))
                chain.unshift(basename(at));
            return chain.length > 0 ? ` (via ${chain.join(" > ")})` : "";
        };
        for (const [path, route] of seen) {
            if (!checked(path) || !(usedBy.get(path) ?? []).includes(namespace)) continue;
            const name = relative(WEB, path).split(sep).join("/");
            const where = relative(APP, route).split(sep).join("/") || "/";
            missing.push(`${name} on ${where}: ${namespace}${via(path)}`);
        }
    }
    return missing.sort();
}

describe("client translation namespaces", () => {
    it("are handed down on every route that uses them", () => {
        const sources = new Map(files(SRC).map((path) => [path, readFileSync(path, "utf8")]));
        const graph = new Map([...sources].map(([path, source]) => [path, edges(path, source, sources)]));
        expect(missingNamespaces(sources, graph)).toEqual([]);
    });

    it("count a provider only for what is drawn inside it", () => {
        const probe = (name: string) => join(SRC, "components", "probe", `${name}.tsx`);
        const page = join(APP, "probe", "page.tsx");
        const screen = probe("screen");
        const uses = `"use client";\nexport function X() { const t = useTranslations("agents"); }`;
        const sources = new Map<string, string>([
            [page, `export default function Page() { return <Screen />; }`],
            [
                screen,
                `"use client";
                import { Inside } from "@/components/probe/inside";
                import { Outside, outsideHelper } from "@/components/probe/outside";
                import { ClientMessages } from "@/components/i18n/client-namespaces";
                const Later = dynamic(() => import("@/components/probe/later").then((module) => module.Later));
                const Tools = dynamic(() =>
                    Promise.all([import("@/components/probe/tools")]).then(([tools]) =>
                        function Tools() {
                            return <ClientMessages namespaces={["agents"]} fallback={null}><tools.Tool /></ClientMessages>;
                        }
                    )
                );
                export function Screen() {
                    outsideHelper();
                    return (
                        <>
                            <ClientMessages namespaces={["agents"]} fallback={null}>
                                <Inside />
                                <Later />
                                <Outside />
                            </ClientMessages>
                            <Outside />
                            <Tools />
                        </>
                    );
                }`
            ],
            ...["inside", "outside", "later", "tools"].map((name): [string, string] => [probe(name), uses])
        ]);
        // The probe files are not on disk, so the imports are joined by name here.
        const parsed = coverage(screen, sources.get(screen)!);
        const graph = new Map<string, Edge[]>([
            [page, [{ to: screen, covers: new Set() }]],
            [
                screen,
                [
                    { to: probe("inside"), covers: parsed.staticCovers(["Inside"]) },
                    { to: probe("outside"), covers: parsed.staticCovers(["Outside", "outsideHelper"]) },
                    ...parsed.dynamics.map((call) => ({
                        to: probe((call.arguments[0] as ts.StringLiteral).text.split("/").pop()!),
                        covers: parsed.dynamicCovers(call)
                    }))
                ]
            ]
        ]);
        expect(missingNamespaces(sources, graph)).toEqual([
            "src/components/probe/outside.tsx on probe: agents (via page.tsx > screen.tsx)"
        ]);
    });
});
