/**
 * A dialog's form never opens holding what was typed the last time (BUG-0078).
 *
 * `DialogContent` unmounts its children while closed, so state kept inside the
 * content starts again by construction. State kept by the component that
 * renders the `Dialog` root does not: that component stays mounted. Every such
 * component whose dialog fields are its own state must reset them on open -
 * `useResetOnOpen`, an effect on the open state, or a render-time reseed from
 * the record - or be listed below with the reason it has not been moved yet.
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
 * Owners whose dialog is one step of a longer flow (a nested confirm, a picker,
 * a second dialog sharing the same state) or whose fields are also page state.
 * Each needs the flow's own open state passed by hand; tracked in
 * docs/bugs/BUG-0078. Remove an entry once it resets; never add one to pass.
 */
const PENDING = new Set([
    "apps/web/src/app/(app)/apps/deploy/import-site.tsx#ImportSiteButton",
    "apps/game-servers/src/screens/installed/game-console.tsx#GameConsole",
    "apps/places/src/screens/devices/rooms-dialog.tsx#RoomsDialog",
    "apps/web/src/app/(app)/apps/deploy/database-panel.tsx#DatabaseManageDialog",
    "apps/web/src/app/(app)/apps/deploy/settings/automations-section.tsx#AutomationsSection",
    "apps/web/src/app/(app)/automations/[id]/alert-fields.tsx#AlertInFields",
    "apps/web/src/app/(app)/chat/chat-sidebar.tsx#ChatSidebarList",
    "apps/web/src/app/(app)/drive/drive-explorer.tsx#DriveExplorer",
    "apps/web/src/app/(app)/drive/files-view.tsx#FilesView",
    "apps/web/src/app/(app)/vault/sends/sends-view.tsx#SendsView",
    "apps/web/src/app/s/[token]/share-explorer.tsx#ShareExplorer",
    "apps/web/src/components/account-menu.tsx#AccountMenu"
]);

/**
 * Owners whose dialog is not a form, so there is nothing to start from scratch:
 * the state it keeps is the record or the view itself.
 */
const NOT_A_FORM = new Set([
    // The task sheet edits the task in place and saves as it goes.
    "apps/web/src/app/(app)/tasks/task-panel.tsx#TaskPanel",
    // The enlarged map keeps the map style the reader picked.
    "apps/web/src/app/(app)/chat/location-card.tsx#LocationCard"
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

const mentions = (text: string, id: string) => new RegExp(`\\b${id.replace(/\$/g, "\\$")}\\b`).test(text);

/** The components in one file that keep their dialog's fields and never reset them. */
function offenders(file: string, text: string): string[] {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const out: string[] = [];
    const visit = (fn: ts.FunctionLikeDeclaration) => {
        const name = nameOf(sf, fn);
        const states: { value: string; setter: string }[] = [];
        const dialogs: ts.JsxElement[] = [];
        const effects: ts.CallExpression[] = [];
        const seeds: string[] = [];
        let hook = false;
        const walk = (n: ts.Node) => {
            if (n !== fn && isFn(n) && /^[A-Z]/.test(nameOf(sf, n))) return;
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
                if (callee === "useResetOnOpen") hook = true;
                if (/^(React\.)?use(Layout)?Effect$/.test(callee)) effects.push(n);
            }
            if (ts.isIfStatement(n) && fn.body && n.parent === fn.body) seeds.push(n.getText(sf));
            if (ts.isJsxElement(n) && ROOTS.has(n.openingElement.tagName.getText(sf))) dialogs.push(n);
            ts.forEachChild(n, walk);
        };
        ts.forEachChild(fn, walk);
        if (!dialogs.length || hook || !name) return;
        const open = dialogs[0]!.openingElement.attributes.properties.find(
            (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === "open"
        );
        const always = !open || !open.initializer || open.initializer.getText(sf) === "{true}";
        if (dialogs.length === 1 && always) return;
        const fields = new Set<string>();
        for (const dialog of dialogs) {
            const scan = (n: ts.Node) => {
                if (ts.isJsxAttribute(n) && n.initializer) {
                    const attr = n.name.getText(sf);
                    const value = n.initializer.getText(sf);
                    for (const s of states) {
                        if (FIELD_ATTRS.has(attr) && mentions(value, s.value)) fields.add(s.setter);
                        if (CHANGE.test(attr) && mentions(value, s.setter)) fields.add(s.setter);
                    }
                }
                ts.forEachChild(n, scan);
            };
            scan(dialog);
        }
        if (!fields.size) return;
        const openVars = open?.initializer?.getText(sf).match(/[A-Za-z_$][\w$]*/g) ?? [];
        const effectResets = effects.some((effect) => {
            const deps = effect.arguments[1];
            if (!deps || !openVars.some((v) => mentions(deps.getText(sf), v))) return false;
            const body = effect.arguments[0]?.getText(sf) ?? "";
            return [...fields].some((setter) => body.includes(setter));
        });
        const reseeds = seeds.some((seed) => [...fields].some((setter) => seed.includes(`${setter}(`)));
        if (!effectResets && !reseeds) out.push(name);
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
        const rel = relative(DASHBOARD, file).split("\\").join("/");
        for (const name of offenders(rel, text)) {
            if (!NOT_A_FORM.has(`${rel}#${name}`)) found.push(`${rel}#${name}`);
        }
    }

    it("leaves no dialog owner holding last time's values", () => {
        expect(found.filter((key) => !PENDING.has(key))).toEqual([]);
    });

    it("lists only owners that still need it", () => {
        expect([...PENDING].filter((key) => !found.includes(key))).toEqual([]);
    });
});
