/**
 * Which of Polaris's right-click entries a box gets.
 *
 * A password box is where a new password is made; any other box is where the
 * code or an email goes. Offering the generator on a search box is an entry
 * that types a password somewhere it will be read.
 */

import { describe, expect, it } from "vitest";
import {
    MENU,
    MENU_ENTRIES,
    POLAR_MENU,
    POLAR_MENU_ENTRIES,
    ROOT_CONTEXTS,
    isPolarEntry,
    polarAskFor,
    polarMenuEntries,
    visibleEntries
} from "../src/lib/context-menu";
import { wordsIn } from "../src/lib/words";

describe("the right-click entries", () => {
    it("offers the login and a new password on a password box", () => {
        expect(visibleEntries("password")).toEqual({
            [MENU.fill]: true,
            [MENU.generate]: true,
            [MENU.code]: false,
            [MENU.email]: false
        });
    });

    it("offers the login, the code and your email on any other box", () => {
        expect(visibleEntries("text")).toEqual({
            [MENU.fill]: true,
            [MENU.generate]: false,
            [MENU.code]: true,
            [MENU.email]: true
        });
    });

    it("has an answer for every entry it creates", () => {
        for (const target of ["password", "text"] as const) {
            const shown = visibleEntries(target);
            for (const entry of MENU_ENTRIES) expect(typeof shown[entry.id]).toBe("boolean");
        }
    });
});

describe("Polar's right-click entries", () => {
    it("shows each entry only where it has something to ask about", () => {
        const contexts = Object.fromEntries(
            POLAR_MENU_ENTRIES.map((entry) => [entry.id, entry.context])
        );
        expect(contexts).toEqual({
            [POLAR_MENU.selection]: "selection",
            [POLAR_MENU.explain]: "selection",
            [POLAR_MENU.summarize]: "selection",
            [POLAR_MENU.translate]: "selection",
            [POLAR_MENU.link]: "link",
            [POLAR_MENU.image]: "image",
            [POLAR_MENU.page]: "page"
        });
        // The parent shows wherever any child can.
        for (const entry of POLAR_MENU_ENTRIES) expect(ROOT_CONTEXTS).toContain(entry.context);
        expect(ROOT_CONTEXTS).toContain("editable");
    });

    it("is titled in the reader's language", () => {
        const spanish = polarMenuEntries(wordsIn("es-ES"));
        expect(spanish.find((entry) => entry.id === POLAR_MENU.selection)?.title).toBe(
            "Preguntar a Polar"
        );
        expect(POLAR_MENU_ENTRIES[0]?.title).toBe("Ask Polar about this");
        for (const entry of spanish) expect(entry.title).not.toMatch(/^menu[.]/);
    });

    it("tells Polar's entries from the vault's", () => {
        expect(isPolarEntry(POLAR_MENU.page)).toBe(true);
        expect(isPolarEntry(MENU.fill)).toBe(false);
    });

    it("quotes a selection and types the question, never sending it", () => {
        expect(polarAskFor(POLAR_MENU.selection, { selectionText: "  the text " })).toEqual({
            quote: "the text"
        });
        expect(polarAskFor(POLAR_MENU.explain, { selectionText: "x" })).toEqual({
            quote: "x",
            draft: "Explain this in simple terms."
        });
        expect(
            polarAskFor(POLAR_MENU.translate, { selectionText: "x" }, wordsIn("es-ES"))?.draft
        ).toBe("Tradúcelo al español.");
        expect(polarAskFor(POLAR_MENU.summarize, { selectionText: "   " })).toBeNull();
    });

    it("passes a link, an image or the page as its address", () => {
        expect(polarAskFor(POLAR_MENU.link, { linkUrl: "https://a.example/x" })?.draft).toBe(
            "What is at this link? https://a.example/x"
        );
        expect(
            polarAskFor(POLAR_MENU.image, { srcUrl: "https://a.example/i.png" })?.draft
        ).toContain("https://a.example/i.png");
        expect(polarAskFor(POLAR_MENU.page, { pageUrl: "https://a.example/" })?.draft).toContain(
            "https://a.example/"
        );
        // Not a web address: nothing to ask about.
        expect(polarAskFor(POLAR_MENU.image, { srcUrl: "data:image/png;base64,AAAA" })).toBeNull();
        expect(polarAskFor(POLAR_MENU.link, { linkUrl: "javascript:void(0)" })).toBeNull();
    });
});
