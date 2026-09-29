/**
 * A server component never calls the browser's translation hook.
 *
 * `useTranslations` from the i18n provider is a client hook. Called in a module
 * that is not a client component - a page, or a shared component a server page
 * renders - it fails the whole route in production with "Attempted to call
 * useTranslations() from the server", which is how /chat went down: its empty
 * page used the hook instead of `getTranslations`. Server code uses
 * `getTranslations` from `@/lib/i18n/request`; a shared component that needs
 * words keeps them in a "use client" module of its own.
 */

import { describe, expect, it } from "vitest";
import { join, relative, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const APPS = resolve(__dirname, "../../..");
const ROOTS = ["web/src", "game-servers/src", "places/src"].map((root) => join(APPS, root));

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return files(path);
        return /\.tsx?$/.test(entry) ? [path] : [];
    });
}

const CLIENT = /^\s*(\/\/[^\n]*\n|\s)*["']use client["']/;
const HOOK_IMPORT = /import\s*\{[^}]*\buseTranslations\b[^}]*\}\s*from\s*["']@\/components\/i18n\/i18n-provider["']/;

describe("the translation hook", () => {
    it("is only imported by client components", () => {
        const offenders = ROOTS.flatMap(files)
            .filter((path) => {
                const source = readFileSync(path, "utf8");
                return HOOK_IMPORT.test(source) && !CLIENT.test(source);
            })
            .map((path) => relative(APPS, path).split("\\").join("/"));
        expect(offenders).toEqual([]);
    });
});
