/**
 * The extension's shortcuts, listed the way Polaris's account page lists its
 * own: what the browser answers to now, grouped, with a way to change each.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ENGLISH } from "../src/lib/words";
import {
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
