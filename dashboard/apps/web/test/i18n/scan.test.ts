/**
 * The scan that measures how much is still English, and the ratchet it holds.
 *
 * The heuristic is asserted on the shapes a screen actually uses - text between
 * tags, a prop that reaches a screen reader, a ternary, an option list, a server
 * action's reply - and on the shapes it must leave alone, which are what would
 * make its numbers noise: class names, identifiers, paths, keys handed to `t`.
 *
 * Then every file listed as migrated is held to zero. That list is the progress
 * record the next migration adds to; a string typed back into one of them fails
 * here with its line.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error - a plain ES module script, typed by its JSDoc.
import { areaOf, looksLikeCopy, scan, scanSource } from "../../scripts/i18n-scan.mjs";

interface Finding {
    line: number;
    kind: string;
    name: string;
    text: string;
    path?: string;
}

const find = (source: string, file = "screen.tsx") =>
    (scanSource(source, file) as Finding[]).map((finding) => finding.text);

describe("what the scan counts as copy", () => {
    it("finds text between tags and the props a reader meets", () => {
        const source = `
            export function Card() {
                return (
                    <div className="flex gap-2" title="Your files">
                        <h1>Preferences</h1>
                        <input placeholder="What are you up to?" aria-label={"Search people"} />
                        <p>{busy ? "Saving..." : "Save"}</p>
                        <img alt={\`Photo of \${name}\`} />
                    </div>
                );
            }`;
        expect(find(source)).toEqual([
            "Your files",
            "Preferences",
            "What are you up to?",
            "Search people",
            "Saving...",
            "Save",
            "Photo of {}"
        ]);
    });

    it("finds option lists, toasts and replies", () => {
        const source = `
            const OPTIONS = [{ value: "dmy", label: "Day first" }];
            toast.show({ title: "Your favorites could not be saved." });
            export async function act() { return { error: "That is not a status" }; }`;
        expect(find(source, "actions.ts")).toEqual([
            "Day first",
            "Your favorites could not be saved.",
            "That is not a status"
        ]);
    });

    it("leaves values alone", () => {
        const source = `
            <a href="/account" className="text-sm font-medium" data-state="open" title="auto">
                {t("preferences.title")}
                {" "}
                {count}
                -
            </a>`;
        expect(find(source)).toEqual([]);
    });

    it("skips a literal marked as not being copy", () => {
        expect(find(`const meta = { title: "Polaris" }; // i18n-ignore`, "layout.ts")).toEqual([]);
        expect(find(`// i18n-ignore\nconst meta = { title: "Polaris" };`, "layout.ts")).toEqual([]);
    });

    it.each([
        ["Save", true],
        ["Set a status", true],
        ["auto", false],
        ["on-hover", false],
        ["/account/preferences", false],
        ["https://example.com", false],
        ["ACCOUNT_TRIGGER", false],
        ["nav.account.signOut", false],
        ["2FA", true],
        ["-", false],
        ["  ", false]
    ])("%s is copy: %s", (text, copy) => {
        expect(looksLikeCopy(text)).toBe(copy);
    });
});

describe("the areas findings are counted under", () => {
    it.each([
        ["web/src/app/(app)/chat/chat-shell.tsx", "chat"],
        ["web/src/app/(app)/apps/deploy/actions.ts", "apps/deploy"],
        ["web/src/app/oauth/login/page.tsx", "oauth"],
        ["web/src/app/layout.tsx", "app"],
        ["web/src/components/transfers/transfers-view.tsx", "components/transfers"],
        ["web/src/components/app-sidebar.tsx", "components"],
        ["web/src/lib/apps.ts", "lib"],
        ["game-servers/src/screens/players.tsx", "game-servers"]
    ])("%s is %s", (path, area) => {
        expect(areaOf(path)).toBe(area);
    });
});

describe("a migrated file", () => {
    const APPS = resolve(__dirname, "../../..");
    const listed = JSON.parse(readFileSync(resolve(__dirname, "../../scripts/i18n-migrated.json"), "utf8")) as {
        files: string[];
    };

    it("is listed, so this cannot pass by checking nothing", () => {
        expect(listed.files.length).toBeGreaterThan(5);
    });

    it.each(listed.files)("%s has no English left in it", (path) => {
        const findings = (scan([join(APPS, path)]) as Finding[]).map(
            (finding) => `${finding.path}:${finding.line} ${finding.text}`
        );
        expect(findings).toEqual([]);
    });
});
