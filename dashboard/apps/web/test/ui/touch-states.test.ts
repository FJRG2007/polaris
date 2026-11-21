/**
 * On a phone a control looks pressed only while the finger is on it.
 *
 * A touch screen keeps the last tapped element "hovered" and, after a sheet
 * closes, "focused" until the next tap, so anything drawn on `hover:` or plain
 * `focus:` stays lit. The chat's "+" went further and was drawn with a grey disc
 * at rest, which reads exactly like a hover circle that never goes away. These
 * guard the three ways back: Tailwind's hover only where the pointer hovers, a
 * hover never mirrored onto plain `focus:`, and the phone's "+" bare until pressed.
 */

import { describe, expect, it } from "vitest";
import { join, relative, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const WEB = resolve(import.meta.dirname, "../..");
const ROOTS = [resolve(WEB, "src"), resolve(WEB, "../../packages/ui/src")];

function* sources(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) yield* sources(path);
        else if (/\.tsx?$/.test(name)) yield path;
    }
}

describe("touch states", () => {
    it("apply hover only where the pointer can hover, in every Tailwind build", () => {
        for (const config of ["tailwind.config.ts", "../site/tailwind.config.ts"]) {
            const text = readFileSync(resolve(WEB, config), "utf8");
            expect(text, config).toMatch(/future:\s*\{[^}]*hoverOnlyWhenSupported:\s*true/);
        }
    });

    it("never mirror a hover onto plain focus, which a tap leaves behind", () => {
        const found: string[] = [];
        for (const root of ROOTS) {
            for (const file of sources(root)) {
                const text = readFileSync(file, "utf8");
                // One class string at a time. A field you type in keeps its focus
                // while typing on purpose, so `bg-field` strings are not buttons,
                // and a border that firms up on focus is that field idiom too.
                for (const match of text.matchAll(/"[^"\n]*\bhover:[^"\n]*"/g)) {
                    if (match[0].includes("bg-field")) continue;
                    const sticky = match[0].match(/(?<![\w-])focus:(text|bg|opacity|ring)-[^\s"]+/);
                    if (!sticky) continue;
                    const line = text.slice(0, match.index).split("\n").length;
                    found.push(`${relative(root, file)}:${line} ${sticky[0]} (use focus-visible:)`);
                }
            }
        }
        expect(found).toEqual([]);
    });

    it("leave the phone composer's + bare at rest and fill it only while pressed", () => {
        const composer = readFileSync(resolve(WEB, "src/app/(app)/chat/composer.tsx"), "utf8");
        const button = composer.slice(composer.indexOf("aria-label={t(\"attachSheet.title\")}"));
        const className = button.match(/className="([^"]*)"/)?.[1] ?? "";
        expect(className).toContain("rounded-full");
        const classes = className.split(/\s+/);
        // A background with no variant in front of it is a disc drawn all the time.
        expect(classes.filter((name) => name.startsWith("bg-"))).toEqual([]);
        expect(classes.some((name) => name.startsWith("active:bg-"))).toBe(true);
    });
});
