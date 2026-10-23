/**
 * The extension's shortcuts, listed the way Polaris's account page lists its
 * own: what the browser answers to now, grouped, with a way to change each.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ENGLISH } from "../src/lib/words";
import {
    BLOCKED_HOSTS_KEY,
    PAGE_FILLING_KEY,
    readPageFilling,
    readPageFillingValues,
    savePageFilling
} from "../src/lib/page-filling";
import {
    PageFillingSheet,
    ShortcutSheet,
    keyCaps,
    matchesPolaris,
    shortcutGroups
} from "../src/entrypoints/popup/settings";

describe("the shortcuts list", () => {
    it("shows the keys the browser holds, not the ones suggested", () => {
        const groups = shortcutGroups(
            [
                { name: "fill-login", shortcut: "Ctrl+Shift+L" },
                { name: "open-polar", shortcut: "" }
            ],
            ENGLISH
        );
        expect(groups.map((group) => group.title)).toEqual(["Vault", "Polar"]);
        expect(groups[0]?.rows[0]?.keys).toBe("Ctrl+Shift+L");
        expect(groups[1]?.rows[0]).toMatchObject({ label: "Open or close Polar", keys: "" });
    });

    it("leaves Polar's out for an account that may not use it", () => {
        const groups = shortcutGroups([{ name: "open-polar", shortcut: "Ctrl+J" }], ENGLISH, false);
        expect(groups.map((group) => group.id)).toEqual(["vault"]);
    });

    it("draws keys as caps, a row per action, and says None for no key", () => {
        const markup = renderToStaticMarkup(
            <ShortcutSheet
                groups={shortcutGroups([{ name: "fill-login", shortcut: "Ctrl+Shift+L" }], ENGLISH)}
                firefox={false}
                recording={null}
                onChange={() => {}}
                onKey={() => {}}
                onStop={() => {}}
                t={ENGLISH}
            />
        );
        expect(markup.match(/class="key-cap"/g)).toHaveLength(3);
        expect(markup.match(/class="sheet-row"/g)).toHaveLength(2);
        expect(markup).toContain("None");
        // Polar on a key that is not Polaris's own: say which key Polaris uses.
        expect(markup).toContain("Polaris opens Polar with Ctrl+J.");
    });

    it("reads a Mac's symbols as one cap each", () => {
        expect(keyCaps("Ctrl+J")).toEqual(["Ctrl", "J"]);
        expect(keyCaps("⌘J")).toEqual(["⌘", "J"]);
        expect(matchesPolaris("Ctrl+J")).toBe(true);
        expect(matchesPolaris("⌘J")).toBe(true);
        expect(matchesPolaris("Alt+P")).toBe(false);
    });
});

describe("filling inside web pages", () => {
    const draw = (on: boolean, blocked: string[]): string =>
        renderToStaticMarkup(
            <PageFillingSheet
                on={on}
                blocked={blocked}
                note={null}
                onTurn={() => {}}
                onUnblock={() => {}}
                t={ENGLISH}
            />
        );

    it("is on unless somebody turned it off, and keeps only real hosts", () => {
        expect(readPageFillingValues(undefined, undefined)).toEqual({ on: true, blocked: [] });
        expect(readPageFillingValues(false, ["a.example", "", 3])).toEqual({
            on: false,
            blocked: ["a.example"]
        });
    });

    it("says what each choice does", () => {
        expect(draw(true, [])).toContain("offered under the boxes");
        expect(draw(false, [])).toContain("Nothing is drawn inside pages");
    });

    it("lists the sites it was switched off for, each with a way back", () => {
        const markup = draw(true, ["shop.example", "bank.example"]);
        expect(markup.match(/data-blocked=/g)).toHaveLength(2);
        expect(markup).toContain("Turn Polaris back on for bank.example");
        expect(draw(true, [])).toContain("No site is switched off.");
    });

    it("stores both under the names the worker reads", async () => {
        const held: Record<string, unknown> = { "blocked.hosts": ["a.example", "b.example"] };
        const api = {
            storage: {
                local: {
                    get: async (key: string) => ({ [key]: held[key] }),
                    set: async (items: Record<string, unknown>) => void Object.assign(held, items)
                }
            }
        };
        await savePageFilling(api, false);
        expect(await readPageFilling(api)).toEqual({
            on: false,
            blocked: ["a.example", "b.example"]
        });
        expect(PAGE_FILLING_KEY).toBe("local:inline.enabled");
        expect(BLOCKED_HOSTS_KEY).toBe("local:blocked.hosts");
    });
});
