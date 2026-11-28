/**
 * A dialog's form never opens holding what was typed the last time (BUG-0078).
 *
 * `DialogContent` unmounts its children while closed, so state kept inside the
 * content starts again by construction. State kept by the component that
 * renders the `Dialog` root does not: that component stays mounted. Every such
 * component whose dialog fields are its own state must reset them on open -
 * `useResetOnOpen` or an effect on that dialog's open state, a render-time
 * reseed from the record, or every action that opens it setting the field -
 * and each dialog is checked on its own, so a component with two dialogs and
 * a reset for one of them fails for the other.
 */

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { join, relative, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const DASHBOARD = resolve(import.meta.dirname, "../../../..");
const ROOTS = new Set(["Dialog", "RadixDialog.Root", "Sheet"]);
const FIELD_ATTRS = new Set(["value", "checked", "defaultValue", "selected", "defaultChecked"]);
const CHANGE = /^on(Change|ValueChange|CheckedChange|Input|Select)$/;

/**
 * Fields a dialog keeps across a close on purpose, by `file#Component(open
 * state)`: what it shows is not something the reader typed. Each entry names
 * the reason; never add one to make a form pass.
 */
const KEPT = new Map<string, string[]>([
    // The progress bar follows an import the server runs whether the dialog is open or not.
    ["apps/web/src/app/(app)/apps/deploy/import-site.tsx#ImportSiteButton(open)", ["setPhase"]],
    // The enlarged map keeps the map style the reader picked.
    ["apps/web/src/app/(app)/chat/location-card.tsx#LocationCard(big && !phone)", ["setStyle"]],
    // The open state of the delete confirm inside the task sheet, set by its menu item.
    ["apps/web/src/app/(app)/tasks/task-panel.tsx#TaskPanel(openId !== null)", ["setConfirmDelete"]]
]);

function sources(): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            if (name === "node_modules" || name.startsWith(".")) continue;
            const path = join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else if (name.endsWith(".tsx") && !name.includes(".test.")) found.push(path);
        }
    };
    for (const group of ["apps", "packages"]) {
        for (const name of readdirSync(join(DASHBOARD, group))) {
            const src = join(DASHBOARD, group, name, "src");
            if (existsSync(src)) walk(src);
        }
    }
    return found;
}

const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
    ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n);

function nameOf(sf: ts.SourceFile, n: ts.FunctionLikeDeclaration): string {
    if (n.name) return n.name.getText(sf);
    let parent = n.parent;
    while (parent && ts.isCallExpression(parent)) parent = parent.parent;
    return parent && ts.isVariableDeclaration(parent) ? parent.name.getText(sf) : "";
}

const mentions = (text: string, id: string) =>
    new RegExp(`\\b${id.replace(/\$/g, "\\$")}\\b`).test(text);

/** The expression a dialog is open on: its `open` prop, or the condition it is rendered under. */
function openOf(sf: ts.SourceFile, dialog: ts.JsxElement): string | null {
    const attr = dialog.openingElement.attributes.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === "open"
    );
    const given = attr?.initializer
        ?.getText(sf)
        .replace(/^\{([\s\S]*)\}$/, "$1")
        .trim();
    if (given && given !== "true") return given;
    // `{shown && <Dialog open>}` or `{shown ? <Dialog open> : null}`
    let up: ts.Node = dialog.parent;
    while (ts.isParenthesizedExpression(up)) up = up.parent;
    if (
        ts.isBinaryExpression(up) &&
        up.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    )
        return up.left.getText(sf);
    if (ts.isConditionalExpression(up)) return up.condition.getText(sf);
    // Always open: whoever renders the component mounts it only while shown.
    return null;
}

const ids = (text: string) => text.match(/[A-Za-z_$][\w$]*/g) ?? [];
const CLOSED = new Set(["false", "null", "undefined", '""', "''", "[]", "0"]);

/**
 * Every dialog in one file whose fields are kept by the component rendering
 * its root and are not put back when it opens, as `Component(open state)`.
 * Each dialog is judged on its own: a reset tied to one dialog's open state
 * does not cover another dialog of the same component.
 */
/** The KEPT entries some dialog still needs, filled in as files are read. */
const used = new Set<string>();

function offenders(file: string, text: string): string[] {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const out: string[] = [];
    const visit = (fn: ts.FunctionLikeDeclaration) => {
        const name = nameOf(sf, fn);
        const states: { value: string; setter: string }[] = [];
        const dialogs: ts.JsxElement[] = [];
        const resets: { on: string; body: string }[] = [];
        const seeds: string[] = [];
        const handlers: ts.FunctionLikeDeclaration[] = [];
        const locals = new Map<string, string>();
        const walk = (n: ts.Node) => {
            if (n !== fn && isFn(n) && /^[A-Z]/.test(nameOf(sf, n))) return;
            if (n !== fn && isFn(n)) {
                handlers.push(n);
                const own = nameOf(sf, n);
                if (own) locals.set(own, n.getText(sf));
            }
            if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
                // `const reset = useCallback(() => ..., [])`
                if (ts.isCallExpression(n.initializer))
                    locals.set(n.name.text, n.initializer.getText(sf));
            }
            if (
                ts.isVariableDeclaration(n) &&
                n.initializer &&
                ts.isCallExpression(n.initializer) &&
                /^(React\.)?useState$/.test(n.initializer.expression.getText(sf)) &&
                ts.isArrayBindingPattern(n.name)
            ) {
                const [value, setter] = n.name.elements;
                if (value && setter && ts.isBindingElement(value) && ts.isBindingElement(setter))
                    states.push({ value: value.name.getText(sf), setter: setter.name.getText(sf) });
            }
            if (ts.isCallExpression(n)) {
                const callee = n.expression.getText(sf);
                const [first, second] = n.arguments;
                if (callee === "useResetOnOpen" && first && second)
                    resets.push({ on: first.getText(sf), body: second.getText(sf) });
                if (/^(React\.)?use(Layout)?Effect$/.test(callee) && first && second)
                    resets.push({ on: second.getText(sf), body: first.getText(sf) });
            }
            if (ts.isIfStatement(n) && fn.body && n.parent === fn.body) seeds.push(n.getText(sf));
            if (ts.isJsxElement(n) && ROOTS.has(n.openingElement.tagName.getText(sf)))
                dialogs.push(n);
            ts.forEachChild(n, walk);
        };
        ts.forEachChild(fn, walk);
        if (!name) return;
        // A body and the local functions it calls, one level deep.
        const expand = (body: string) =>
            [body, ...ids(body).flatMap((id) => (locals.has(id) ? [locals.get(id)!] : []))].join(
                "\n"
            );
        for (const dialog of dialogs) {
            const open = openOf(sf, dialog);
            if (open === null) continue;
            const openIds = ids(open);
            const opening = states.filter((s) => openIds.includes(s.value));
            const fields = new Set<string>();
            const scan = (n: ts.Node) => {
                if (ts.isJsxAttribute(n) && n.initializer) {
                    const attr = n.name.getText(sf);
                    const value = n.initializer.getText(sf);
                    for (const s of states) {
                        // The open state itself is the record the opener hands in.
                        if (opening.includes(s)) continue;
                        if (FIELD_ATTRS.has(attr) && mentions(value, s.value)) fields.add(s.setter);
                        if (CHANGE.test(attr) && mentions(value, s.setter)) fields.add(s.setter);
                    }
                }
                ts.forEachChild(n, scan);
            };
            scan(dialog);
            if (!fields.size) continue;
            const tied = resets
                .filter((r) => openIds.some((v) => mentions(r.on, v)))
                .map((r) => expand(r.body));
            // The actions that open it; each one has to set the field itself.
            const openers = handlers.filter((h) => {
                const params = h.parameters.map((p) => p.name.getText(sf));
                const calls: ts.CallExpression[] = [];
                const find = (n: ts.Node) => {
                    if (ts.isCallExpression(n)) calls.push(n);
                    if (n === h || !isFn(n)) ts.forEachChild(n, find);
                };
                find(h);
                return calls.some((call) => {
                    const arg = call.arguments[0]?.getText(sf) ?? "";
                    const state = opening.find((s) => s.setter === call.expression.getText(sf));
                    // `onOpenChange={(next) => setOpen(next)}` only passes the close on.
                    const passed = params.includes(arg) && state?.value === open;
                    return state !== undefined && arg !== "" && !CLOSED.has(arg) && !passed;
                });
            });
            const covered = (setter: string) =>
                tied.some((body) => body.includes(setter)) ||
                seeds.some((seed) => expand(seed).includes(`${setter}(`)) ||
                (openers.length > 0 &&
                    openers.every((h) => expand(h.getText(sf)).includes(`${setter}(`)));
            const key = `${file}#${name}(${open.replace(/\s+/g, " ")})`;
            const kept = KEPT.get(key) ?? [];
            const left = [...fields].filter((setter) => !covered(setter));
            for (const setter of kept) if (left.includes(setter)) used.add(`${key}:${setter}`);
            const missing = left.filter((setter) => !kept.includes(setter));
            if (missing.length) out.push(`${key}: ${missing.join(", ")}`);
        }
    };
    const all = (n: ts.Node) => {
        if (isFn(n) && /^[A-Z]/.test(nameOf(sf, n))) visit(n);
        ts.forEachChild(n, all);
    };
    all(sf);
    return out;
}

describe("dialog forms reset when they open", () => {
    const found: string[] = [];
    for (const file of sources()) {
        const text = readFileSync(file, "utf8");
        if (!/<(Dialog|Sheet)\b/.test(text)) continue;
        found.push(...offenders(relative(DASHBOARD, file).split("\\").join("/"), text));
    }

    it("leaves no dialog holding last time's values", () => {
        expect(found).toEqual([]);
    });

    it("checks each dialog of a component on its own", () => {
        const two = `
            function Folder() {
                const [naming, setNaming] = useState(false);
                const [name, setName] = useState("");
                const [moving, setMoving] = useState(false);
                const [where, setWhere] = useState("");
                useResetOnOpen(naming, () => setName(""));
                return (
                    <>
                        <Dialog open={naming}><Input value={name} onChange={(e) => setName(e.target.value)} /></Dialog>
                        <Dialog open={moving}><Input value={where} onChange={(e) => setWhere(e.target.value)} /></Dialog>
                    </>
                );
            }`;
        expect(offenders("folder.tsx", two)).toEqual(["folder.tsx#Folder(moving): setWhere"]);
        const seeded = two.replace(
            "const [where",
            'const open = () => { setWhere(""); setMoving(true); };\n const [where'
        );
        expect(offenders("folder.tsx", seeded)).toEqual([]);
    });

    it("keeps on purpose only fields that would otherwise fail", () => {
        const listed = [...KEPT].flatMap(([key, setters]) =>
            setters.map((setter) => `${key}:${setter}`)
        );
        expect(listed.filter((entry) => !used.has(entry))).toEqual([]);
    });
});
