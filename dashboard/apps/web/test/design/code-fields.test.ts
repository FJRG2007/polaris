/**
 * Code is typed into a painted field, never a bare monospace textarea.
 *
 * Every box that takes code - JSON, a script, a command, YAML - goes through
 * `JsonEditor` or `CodeEditor` (`components/json-view.tsx`), which highlight it
 * with the same theme as the read-only views. A `Textarea` with `font-mono` is
 * how an unpainted one slips in, so each such element across the apps fails
 * here unless it is listed below with the reason it holds no code.
 */

import { describe, expect, it } from "vitest";
import { join, relative, resolve } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

const APPS = resolve(import.meta.dirname, "../../..");

/**
 * Monospace textareas that hold something with no grammar to paint, by path
 * under `apps/` and how many each file may have. A new one in a listed file
 * still fails: the count is exact.
 */
const NOT_CODE: Record<string, { count: number; why: string }> = {
    "game-servers/src/components/formatted-text-field.tsx": { count: 1, why: "paints its own Minecraft colour codes over the box" },
    "game-servers/src/screens/installed/console-keep-dialog.tsx": { count: 1, why: "a game server console command, no grammar" },
    "game-servers/src/screens/installed/game-console.tsx": { count: 1, why: "game server console commands, no grammar" },
    "web/src/app/(app)/admin/integrations/integrations-view.tsx": { count: 2, why: "an API key and a GitHub App private key" },
    "web/src/app/(app)/analytics/ignored-traffic.tsx": { count: 1, why: "a list of addresses and paths" },
    "web/src/app/(app)/apps/databases/connection-dialog.tsx": { count: 1, why: "a certificate or key file" },
    "web/src/app/(app)/apps/deploy/service-settings.tsx": { count: 3, why: "a certificate, its private key, and watch-path globs" },
    "web/src/app/(app)/apps/deploy/edge-settings.tsx": { count: 1, why: "a Content-Security-Policy value, no grammar" },
    "web/src/app/(app)/apps/servers/[serverId]/templates-dialog.tsx": { count: 1, why: "a list of package names" },
    "web/src/app/(app)/apps/servers/server-ssh-keys.tsx": { count: 2, why: "SSH public keys" },
    "web/src/app/(app)/automations/code-review/repo-dialog.tsx": { count: 1, why: "free-form notes for the agent" },
    "web/src/app/(app)/drive/connection-dialog.tsx": { count: 1, why: "an SSH private key" },
    "web/src/app/(app)/drive/viewer/markdown-view.tsx": { count: 1, why: "a whole Markdown document; Find selects matches in the native box" },
    "web/src/app/(app)/drive/viewer/text-editor.tsx": { count: 1, why: "plain-text files; code files open in the code viewer" },
    "web/src/app/(app)/network-filter/fields.tsx": { count: 1, why: "a list of domains and patterns" },
    "web/src/app/(app)/vault/recovery-codes.tsx": { count: 1, why: "recovery codes" },
    "web/src/app/(app)/vault/item-dialog.tsx": { count: 2, why: "an SSH key pair" },
    "web/src/app/(app)/vault/sends/sends-view.tsx": { count: 1, why: "a secret text" },
    "web/src/components/rules/condition-builder.tsx": { count: 1, why: "a rule expression, a syntax with no grammar to paint" },
    "web/src/app/tr/[token]/submit-text-form.tsx": { count: 1, why: "a visitor's free text in no known language" }
};

/** The painted editors themselves. */
const EDITORS = new Set(["web/src/components/json-view.tsx", "web/src/components/code-surface.tsx"]);

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sources(path);
        return entry.name.endsWith(".tsx") ? [path] : [];
    });
}

/** The opening tag that starts at `from`: up to the first `>` outside braces and quotes. */
function openingTag(source: string, from: number): string {
    let depth = 0;
    let quote: string | null = null;
    for (let at = from + 1; at < source.length; at += 1) {
        const char = source[at];
        if (quote) {
            if (char === quote) quote = null;
        } else if (char === "{") depth += 1;
        else if (char === "}") depth -= 1;
        else if (depth === 0 && (char === "\"" || char === "'")) quote = char;
        else if (depth === 0 && char === ">") return source.slice(from, at + 1);
    }
    return source.slice(from);
}

/** How many textareas in a file carry `font-mono` on their own tag. */
function monoTextareas(source: string): number {
    let found = 0;
    for (const match of source.matchAll(/<(?:Textarea|textarea)\b/g)) {
        if (/\bfont-mono\b/.test(openingTag(source, match.index))) found += 1;
    }
    return found;
}

const counts = new Map<string, number>();
for (const app of readdirSync(APPS, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    let files: string[];
    try {
        files = sources(join(APPS, app.name, "src"));
    } catch {
        continue;
    }
    for (const file of files) {
        const key = relative(APPS, file).replaceAll("\\", "/");
        if (EDITORS.has(key)) continue;
        const count = monoTextareas(readFileSync(file, "utf8"));
        if (count > 0) counts.set(key, count);
    }
}

describe("code fields", () => {
    it("finds the textareas it scans", () => {
        expect(monoTextareas('<Textarea className="font-mono text-xs" value={a} />')).toBe(1);
        expect(monoTextareas("<Textarea\n    value={x}\n    onChange={(e) => set(e.target.value)}\n    className=\"font-mono\"\n/>")).toBe(1);
        expect(monoTextareas('<Textarea className="text-sm" />\n<div className="font-mono" />')).toBe(0);
        expect(counts.size).toBeGreaterThan(0);
    });

    it("paints every monospace textarea that takes code", () => {
        const offenders = [...counts]
            .filter(([file, count]) => count !== NOT_CODE[file]?.count)
            .map(([file, count]) => `${file}: ${count} (allowed ${NOT_CODE[file]?.count ?? 0})`);
        expect(offenders, "use JsonEditor or CodeEditor from components/json-view").toEqual([]);
    });

    it("lists no file that has lost its plain box", () => {
        const stale = Object.keys(NOT_CODE).filter((file) => !counts.has(file));
        expect(stale).toEqual([]);
    });
});
