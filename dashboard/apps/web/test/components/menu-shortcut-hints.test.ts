/**
 * A key written beside a menu option is a key somebody will press.
 *
 * Menus print an action's keys with `<ShortcutHint id="...">`, and the hint is
 * only honest while the screen listens for that same action. Nothing but
 * convention ties the two together, so they are read here as source: every
 * hinted id must be heard - through `shortcutPressed` or `matchShortcut` - in the
 * file that draws the menu or in the file that owns that screen's keyboard. A
 * hint added without its handler is a failing test rather than a key that does
 * nothing.
 */

import { describe, expect, it } from "vitest";
import { join, relative, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const APPS = resolve(__dirname, "../../..");
const ROOTS = readdirSync(APPS)
    .map((name) => join(APPS, name, "src"))
    .filter((path) => {
        try {
            return statSync(path).isDirectory();
        } catch {
            return false;
        }
    });

/**
 * Menus whose keys are heard by another file of the same screen - the menu is
 * drawn by one component and the keyboard owned by the screen around it.
 */
const HEARD_IN: Readonly<Record<string, readonly string[]>> = {
    "web/src/app/(app)/chat/message-menu.tsx": ["web/src/app/(app)/chat/message-list.tsx"],
    "web/src/app/(app)/office/p/[id]/format-bar.tsx": [
        "web/src/app/(app)/office/p/[id]/slides-editor.tsx"
    ],
    "web/src/app/(app)/office/p/[id]/slide-list.tsx": [
        "web/src/app/(app)/office/p/[id]/slides-editor.tsx"
    ]
};

function sources(root: string): string[] {
    const found: string[] = [];
    for (const name of readdirSync(root)) {
        const path = join(root, name);
        if (statSync(path).isDirectory()) found.push(...sources(path));
        else if (/\.tsx?$/.test(name)) found.push(path);
    }
    return found;
}

const key = (path: string) => relative(APPS, path).replaceAll("\\", "/");

/** The string literals inside a bracketed list. */
const literals = (list: string) =>
    [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);

/**
 * Every action id a file listens for: `shortcutPressed(event, "id")`, a local
 * `pressed("id")` that wraps it, and `matchShortcut(event, [...])` whether the
 * list is written inline or kept in a constant of the same file.
 */
function heard(text: string): Set<string> {
    const ids = new Set<string>();
    for (const match of text.matchAll(/shortcutPressed\(\s*[\w.]+\s*,\s*"([^"]+)"/g))
        ids.add(match[1] as string);
    const wrappers = text.matchAll(/const (\w+) = \(\w+(?:: string)?\) => shortcutPressed\(/g);
    for (const [, name] of wrappers)
        for (const match of text.matchAll(new RegExp(`\\b${name}\\(\\s*"([^"]+)"`, "g")))
            ids.add(match[1] as string);
    for (const [, list] of text.matchAll(/matchShortcut\(\s*[\w.]+\s*,\s*\[([^\]]*)\]/g))
        for (const id of literals(list as string)) ids.add(id);
    for (const [, name] of text.matchAll(/matchShortcut\(\s*[\w.]+\s*,\s*([A-Z_]+)\s*\)/g)) {
        const list = new RegExp(`const ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`).exec(text);
        for (const id of literals(list?.[1] ?? "")) ids.add(id);
    }
    return ids;
}

const files = ROOTS.flatMap(sources).filter((path) => !/[\\/](test|__tests__)[\\/]/.test(path));
const text = new Map(files.map((path) => [key(path), readFileSync(path, "utf8")]));
const hinting = [...text].filter(([, source]) => /<ShortcutHint\s+id="/.test(source));

describe("menu shortcut hints", () => {
    it("finds the menus it checks", () => {
        expect(hinting.length).toBeGreaterThan(10);
    });

    it.each(hinting.map(([path]) => path))("%s listens for every key it prints", (path) => {
        const source = text.get(path) as string;
        const listening = heard(source);
        for (const other of HEARD_IN[path] ?? []) {
            const companion = text.get(other);
            expect(companion, `${other} is named as hearing ${path}'s keys`).toBeDefined();
            for (const id of heard(companion as string)) listening.add(id);
        }
        const hinted = [...source.matchAll(/<ShortcutHint\s+id="([^"]+)"/g)].map(
            (match) => match[1] as string
        );
        const unheard = [...new Set(hinted)].filter((id) => !listening.has(id));
        expect(unheard).toEqual([]);
    });
});
