/**
 * A menu is never taller than the room left on screen. The shared surface caps
 * itself at the height Radix measures beside its trigger, and a caller's own
 * `max-h-*` replaces that cap rather than adding to it - Polar's model list,
 * opened from a composer low on the screen, ran past the bottom edge and its
 * last models could not be scrolled to. A caller that wants a shorter menu
 * writes the smaller of its height and the measured one.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SOURCES = ["apps", "packages"];

function sources(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...sources(path));
        else if (entry.name.endsWith(".tsx")) found.push(path);
    }
    return found;
}

/** The `className` given to each menu surface, wherever it sits among the props. */
function menuClasses(text: string): string[] {
    const classes: string[] = [];
    const opening = /<(DropdownMenuContent|DropdownMenuSubContent|ContextMenuContent)\b/g;
    for (let match = opening.exec(text); match; match = opening.exec(text)) {
        const rest = text.slice(match.index, match.index + 2000);
        const className = /className=(?:"([^"]*)"|\{[^}]*?"([^"]*)")/.exec(rest);
        const end = rest.search(/\n\s*>|\/?>\s*\n/);
        if (className && (end < 0 || className.index < end)) {
            classes.push(className[1] ?? className[2] ?? "");
        }
    }
    return classes;
}

describe("a menu's height", () => {
    it("is capped by the room left on screen wherever a caller sets its own", () => {
        const offenders: string[] = [];
        for (const base of SOURCES) {
            for (const file of sources(join(ROOT, base))) {
                for (const className of menuClasses(readFileSync(file, "utf8"))) {
                    for (const token of className.split(/\s+/)) {
                        if (/^max-h-/.test(token) && !token.includes("available-height")) {
                            offenders.push(`${file.slice(ROOT.length)}: ${token}`);
                        }
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
