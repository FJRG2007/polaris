// @vitest-environment jsdom

/**
 * A language picker's rows: the flag, the language in itself, the reader's name
 * for it at the right, and a check on the chosen one. The trigger shows the
 * flag too.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LanguageSelect } from "../src/components/language-select";

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

const LANGUAGES = [
    { value: "da", tag: "da" },
    { value: "de", tag: "de" },
    { value: "en-GB", tag: "en-GB" },
    { value: "es", tag: "es" },
    { value: "en", tag: "en" }
];

function open(value = "es") {
    render(
        <LanguageSelect
            value={value}
            onValueChange={() => undefined}
            languages={LANGUAGES}
            readerLocale="en-US"
            searchPlaceholder="Search"
            emptyText="None"
            aria-label="Language"
        />
    );
    const trigger = screen.getByRole("button", { name: "Language" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    return { trigger, rows: screen.getAllByRole("menuitem") };
}

describe("language picker rows", () => {
    it("names each language in itself, with the reader's name for it muted at the right", () => {
        const { rows } = open();
        const labels = rows.map((row) => row.querySelector("span.flex-1")?.textContent);
        expect(labels).toEqual(["Dansk", "Deutsch", "English (UK)", "Español", "English"]);
        expect(within(rows[0]!).getByTitle("Danish")).toBeTruthy();
        expect(within(rows[3]!).getByTitle("Spanish").className).toContain("text-muted-foreground");
        // The reader's name is left out where it would only repeat the label.
        expect(rows[4]!.querySelectorAll("span[title]")).toHaveLength(1);
    });

    it("puts each language's flag first, and a neutral blank where none fits", async () => {
        const { rows } = open();
        expect(
            rows.map(
                (row) =>
                    row.firstElementChild
                        ?.querySelector("[data-flag]")
                        ?.getAttribute("data-flag") ?? null
            )
        ).toEqual(["dk", "de", "gb", "es", "none"]);
        expect(rows[4]!.querySelector("[data-icon-placeholder]")).not.toBeNull();
        await waitFor(() =>
            expect(
                (rows[1]!.querySelector("[data-flag]") as HTMLElement).style.backgroundImage
            ).toContain("data:image/svg+xml")
        );
    });

    it("checks the chosen row only", () => {
        const { rows } = open("de");
        expect(rows.map((row) => row.querySelector("svg.lucide-check") !== null)).toEqual([
            false,
            true,
            false,
            false,
            false
        ]);
    });

    it("shows the chosen language's flag on the trigger", () => {
        const { trigger } = open("en-GB");
        expect(trigger.querySelector("[data-flag='gb']")).not.toBeNull();
        expect(trigger.textContent).toContain("English (UK)");
    });

    it("finds a language by the reader's name for it", () => {
        open();
        fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "danish" } });
        expect(screen.getAllByRole("menuitem").map((row) => row.textContent)).toEqual([
            "DanskDanish"
        ]);
    });
});
