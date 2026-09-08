// @vitest-environment jsdom

/**
 * What the Mail settings screen's dropdowns say to a screen reader.
 *
 * Each of these is a label over a listbox, drawn the way the rest of Mail's
 * settings are - but a label over a control names nothing for anyone not
 * reading the screen visually: a `<span>` is not `<label for>`, and Radix's
 * trigger is a button rather than a field a click on the text would reach.
 * Without an `aria-label` naming the control itself, five dropdowns are
 * announced as five unlabelled comboboxes in a row.
 */

import * as core from "@polaris/core";
import { ToastProvider } from "@polaris/ui";
import { cleanup, render, screen } from "@testing-library/react";
import { GeneralView } from "@/app/(app)/mail/settings/general/general-view";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/mail/actions", () => ({
    setMailPreferencesAction: async () => ({})
}));

/** The browser storage the reading-layout preference lives in. This
 *  environment does not ship one. */
function browserStorage() {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        writable: true,
        value: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => void values.set(key, String(value)),
            removeItem: (key: string) => void values.delete(key),
            clear: () => values.clear(),
            key: (index: number) => [...values.keys()][index] ?? null,
            get length() {
                return values.size;
            }
        }
    });
}

beforeAll(() => {
    // Radix's listbox reaches for these during measurement; jsdom has neither.
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    Element.prototype.scrollIntoView ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
});

beforeEach(() => browserStorage());
afterEach(() => cleanup());

describe("Mail's general settings, read aloud", () => {
    it("names every dropdown by the question it answers", () => {
        render(
            <ToastProvider>
                <GeneralView preferences={core.MAIL_PREF_DEFAULTS} />
            </ToastProvider>
        );

        for (const name of [
            "Sort lists by",
            "Mark a message as read",
            "After archiving or deleting",
            "Undo send",
            "Reading layout"
        ]) {
            expect(screen.getByRole("combobox", { name })).toBeTruthy();
        }
    });
});
