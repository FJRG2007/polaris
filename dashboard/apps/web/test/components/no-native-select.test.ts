import { describe, expect, it } from "vitest";
import { join, relative, sep } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

/**
 * No screen draws a native `<select>`.
 *
 * A native select opens a menu the operating system draws: it ignores the theme,
 * cannot be searched, and looks different on every machine. Every screen uses
 * the `Select` from `@polaris/ui` instead, and the browser extension's popup,
 * which cannot load that package, uses its own `Picker`.
 *
 * The rule kept being broken one screen at a time, so it is checked here across
 * every app and package rather than reviewed. A file that genuinely needs one
 * goes in the allowlist below with the reason.
 */
const DASHBOARD = join(__dirname, "..", "..", "..", "..");

/** Files allowed a native select, by path from `dashboard/`, and why. */
const ALLOWED: Record<string, string> = {};

/** Every non-test source file under a directory. */
function sources(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            found.push(...sources(path));
            continue;
        }
        if (/\.(?:tsx?|jsx?)$/.test(entry) && !/\.test\.[jt]sx?$/.test(entry)) found.push(path);
    }
    return found;
}

/** Every `src` directory under `apps/*` and `packages/*`. */
function roots(): string[] {
    return ["apps", "packages"].flatMap((group) =>
        readdirSync(join(DASHBOARD, group))
            .map((name) => join(DASHBOARD, group, name, "src"))
            .filter((path) => existsSync(path))
    );
}

/** The source without its comments: a comment that names `<select>` draws none. */
function code(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("no native <select>", () => {
    const files = roots().flatMap(sources);
    const key = (path: string) => relative(DASHBOARD, path).split(sep).join("/");

    it("scans the apps and packages", () => {
        expect(files.length).toBeGreaterThan(100);
        expect(
            files.some((path) => key(path) === "apps/extension/src/entrypoints/popup/app.tsx")
        ).toBe(true);
    });

    it("finds none outside the allowlist", () => {
        const offenders = files
            .filter((path) => /<select\b/.test(code(readFileSync(path, "utf8"))))
            .map(key)
            .filter((path) => !(path in ALLOWED));
        expect(offenders).toEqual([]);
    });

    it("gives every allowlisted file a reason and keeps no stale entry", () => {
        for (const [path, reason] of Object.entries(ALLOWED)) {
            expect(reason.trim()).not.toBe("");
            expect(existsSync(join(DASHBOARD, path)), `${path} no longer exists`).toBe(true);
            const source = code(readFileSync(join(DASHBOARD, path), "utf8"));
            expect(/<select/.test(source), `${path} no longer has a native select`).toBe(true);
        }
    });

    it("catches a select written in JSX", () => {
        expect(/<select\b/.test(code("return (\n    <select value={a}>\n"))).toBe(true);
        expect(/<select\b/.test(code("/** the old <select> was uncontrolled */"))).toBe(false);
    });
});
