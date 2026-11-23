/**
 * In the desktop app the system's minimize, maximize and close buttons are drawn
 * over the top right of the window. A screen-filling surface that starts at the
 * very top put its own top-right controls under them - the deploy service
 * panel's bell, full screen and close were there in a browser and unreachable
 * in the app, and the video viewer's close after that (BUG-0025). Every such
 * surface either goes through `clearWindowControls` (the dialog primitives do it
 * for every dialog) or places itself against `--window-controls-height` on
 * purpose.
 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";

const DASHBOARD = resolve(__dirname, "../../../..");

function walk(directory: string, found: string[] = []): string[] {
    for (const name of readdirSync(directory)) {
        if (name === "node_modules" || name === "dist" || name === "test") continue;
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path, found);
        else if (/\.tsx$/.test(name)) found.push(path);
    }
    return found;
}

interface ClassName {
    readonly line: number;
    readonly text: string;
    readonly tokens: ReadonlySet<string>;
    readonly childless: boolean;
}

/** The class tokens each JSX `className` hands an element, however they are
 *  written: one string, several strings joined by `cn(...)` across lines, a
 *  conditional, or a constant of the same file the expression names. The mail
 *  composer and the video viewer slipped past a check that wanted `fixed` and
 *  `inset-0` in one string, or that took any dimmed surface for a backdrop. */
function classNames(source: string): ClassName[] {
    // Every constant's whole right-hand side, so a class list built by a
    // helper (`const shell = clearWindowControls(...)`) counts as that helper.
    const constants = new Map<string, string>();
    for (const match of source.matchAll(/\bconst\s+(\w+)\s*=/g)) {
        const from = match.index + match[0].length;
        const end = source.indexOf(";\n", from);
        constants.set(match[1]!, source.slice(from, end < 0 ? undefined : end));
    }
    const found: ClassName[] = [];
    for (const match of source.matchAll(/className=/g)) {
        const from = match.index + "className=".length;
        let end = from;
        if (source[from] === "{") {
            for (let depth = 0; end < source.length; end += 1) {
                if (source[end] === "{") depth += 1;
                else if (source[end] === "}" && --depth === 0) break;
            }
        } else if (source[from] === '"' || source[from] === "'") {
            end = source.indexOf(source[from]!, from + 1);
        } else {
            continue;
        }
        let text = source.slice(from, end + 1);
        for (const name of new Set(text.match(/\b[A-Za-z_]\w*\b/g))) {
            const value = constants.get(name);
            if (value !== undefined) text += ` ${value}`;
        }
        const tokens = new Set<string>();
        for (const literal of text.matchAll(/(["'`])([^"'`]*)\1/g)) {
            for (const token of literal[2]!.split(/\s+/)) if (token) tokens.add(token.slice(token.lastIndexOf(":") + 1));
        }
        // The rest of the opening tag, to tell a layer with nothing in it.
        let close = end + 1;
        for (let depth = 0; close < source.length; close += 1) {
            if (source[close] === "{") depth += 1;
            else if (source[close] === "}") depth -= 1;
            else if (source[close] === ">" && depth === 0) break;
        }
        found.push({ line: source.slice(0, match.index).split("\n").length, text, tokens, childless: source[close - 1] === "/" });
    }
    return found;
}

/** Reaches the window's top right: the whole window, a full-height strip, or a
 *  bar across the top - at any width. */
function reachesTopRight(tokens: ReadonlySet<string>): boolean {
    if (!tokens.has("fixed")) return false;
    if (tokens.has("inset-0") || tokens.has("inset-y-0")) return true;
    return tokens.has("top-0") && ["end-0", "right-0", "inset-x-0", "w-full", "w-screen"].some((token) => tokens.has(token));
}

/** A dimmed or blurred layer with nothing in it has no control to cover. */
const BACKDROP = /bg-black\/|bg-background\/|backdrop-blur/;

function sources(): string[] {
    const roots = ["apps", "packages"].flatMap((group) =>
        readdirSync(join(DASHBOARD, group)).map((name) => join(DASHBOARD, group, name, "src"))
    );
    return roots
        .filter((path) => {
            try {
                return statSync(path).isDirectory();
            } catch {
                return false;
            }
        })
        .flatMap((root) => walk(root));
}

describe("the desktop app's window buttons", () => {
    it("never cover the top right of a surface fixed to the whole window", () => {
        const offenders: string[] = [];
        for (const path of sources()) {
            for (const { line, text, tokens, childless } of classNames(readFileSync(path, "utf8"))) {
                if (!reachesTopRight(tokens)) continue;
                // Only a layer with nothing in it: a surface that is
                // see-through only while it is folded away is still a surface.
                if (childless && (BACKDROP.test(text) || tokens.has("pointer-events-none"))) continue;
                if (/clearWindowControls\(|windowControlsBand\(|--window-controls-height/.test(text)) continue;
                offenders.push(`${path.slice(DASHBOARD.length + 1).replace(/\\/g, "/")}:${line}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it("reads a surface's classes however they are written", () => {
        const split = classNames('<div className={cn(\n  "fixed z-50",\n  open && "inset-0 bg-black/90"\n)}><X /></div>')[0]!;
        expect(reachesTopRight(split.tokens)).toBe(true);
        expect(split.childless).toBe(false);
        const named = classNames('const SURFACE = "fixed inset-y-0 end-0";\n<aside className={SURFACE} />')[0]!;
        expect(reachesTopRight(named.tokens)).toBe(true);
        expect(named.childless).toBe(true);
        const narrow = classNames('<div className="max-sm:fixed max-sm:top-0 max-sm:inset-x-0">x</div>')[0]!;
        expect(reachesTopRight(narrow.tokens)).toBe(true);
        const corner = classNames('<div className="fixed bottom-4 end-4">x</div>')[0]!;
        expect(reachesTopRight(corner.tokens)).toBe(false);
    });

    it("start every dialog below them where it is pinned to the top", () => {
        const dialog = readFileSync(join(DASHBOARD, "packages/ui/src/components/dialog.tsx"), "utf8").replace(/\s+/g, " ");
        expect(dialog).toContain("className={clearWindowControls( cn( DIALOG_SURFACE, CENTRED_MOTION, className,");
        expect(dialog).toContain("top-[var(--window-controls-height)]");
    });
});
