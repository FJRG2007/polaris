/**
 * Nobody installing Polaris TV is ever handed a command: no screen, catalog or
 * guide for the TV may name an adb, package-manager or shell line, nor a script
 * from `tv/`. Those stay the installer's job and the developers' tools.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const ROOT = join(__dirname, "..", "..", "..");
const MESSAGES = join(ROOT, "dashboard", "apps", "web", "messages");
const DOCS = join(ROOT, "docs", "features");

/** Shapes of a command line, not words: "Close adb" names a program, "adb shell" is a command. */
const COMMANDS: readonly RegExp[] = [
    /\badb\s+(?:shell|install|connect|pair|tcpip|devices|push|pull|kill-server|reboot|uninstall)\b/i,
    /\b(?:pm|cmd\s+package)\s+(?:install|grant|revoke|list|uninstall|disable|enable|set-home-activity)\b/i,
    /\bappops\s+set\b/i,
    /\bsettings\s+(?:put|get|list)\s+(?:global|secure|system)\b/i,
    /\bgetprop\b/i,
    /\b(?:sh|bash|python3?)\s+\S+/,
    /[\w-]+\.(?:sh|ps1|py)\b/,
    /\btools\/tv\b/
];

/** Every string in a catalog, by its key path. */
function strings(value: unknown, path = ""): [string, string][] {
    if (typeof value === "string") return [[path, value]];
    if (!value || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, child]) => strings(child, path ? `${path}.${key}` : key));
}

function offenders(entries: readonly (readonly [string, string])[]): string[] {
    return entries.filter(([, text]) => COMMANDS.some((command) => command.test(text))).map(([where, text]) => `${where}: ${text}`);
}

describe("TV copy names no command", () => {
    it("catches a command and lets a program's name through", () => {
        expect(offenders([["a", "Run adb shell pm list packages"]])).toHaveLength(1);
        expect(offenders([["b", "Run build-and-install.sh"]])).toHaveLength(1);
        expect(offenders([["c", "Close adb, Android Studio or scrcpy and try again."]])).toEqual([]);
    });

    it.each(["en-US", "es-ES"])("in the web catalogs for the TV (%s)", (locale) => {
        const tvCompat = JSON.parse(readFileSync(join(MESSAGES, locale, "tvCompat.json"), "utf8")) as unknown;
        const account = JSON.parse(readFileSync(join(MESSAGES, locale, "account.json"), "utf8")) as {
            downloads?: { tv?: unknown; };
        };
        expect(account.downloads?.tv).toBeDefined();
        expect(offenders([...strings(tvCompat, "tvCompat"), ...strings(account.downloads?.tv, "downloads.tv")])).toEqual([]);
    });

    it("in the desktop's TV window", () => {
        const pages = ["tv.ts", "tv.html"].map((name) => [name, readFileSync(join(ROOT, "desktop", "src", "renderer", name), "utf8")] as const);
        expect(offenders(pages)).toEqual([]);
    });

    it("in every Polaris TV guide", () => {
        const guides = readdirSync(DOCS).filter((name) => /^polaris-tv-.*\.md$/.test(name));
        expect(guides).toContain("polaris-tv-install.md");
        expect(offenders(guides.map((name) => [name, readFileSync(join(DOCS, name), "utf8")] as const))).toEqual([]);
    });
});
