// @vitest-environment jsdom

/**
 * Which chat Polar shows when it opens (BUG-0016): a new one unless the person
 * chose the last one, with a reload of the open view and the extension's
 * per-tab panel keeping theirs; and the "When Polar opens" setting that
 * chooses it, saved to the account and put back when the server refuses.
 */

import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const { MessagesWrapper } = await import("../setup/i18n");
const { chatOnOpen } = await import("@/lib/polar/open-chat");
const display = await import("@/components/polar/polar-display");
const { OpeningSettings } = await import("@/components/polar/polar-open-settings");
const { POLAR_DISPLAY_DEFAULTS } = await import("@/lib/polar/display");

// What jsdom does not implement and the picker calls on the way open.
Object.assign(Element.prototype, {
    hasPointerCapture: () => false,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    scrollIntoView: () => undefined
});

const base = { continueLast: false, cameBack: false, perTab: false, tabThread: "t-tab", lastThread: "t-last" };

describe("the chat Polar opens on", () => {
    it("is a new one by default, whatever this tab or the browser was last in", () => {
        expect(chatOnOpen(base)).toBeNull();
        expect(POLAR_DISPLAY_DEFAULTS.reopenLastChat).toBe(false);
    });

    it("is this tab's chat, else the browser's, for a person who chose the last one", () => {
        expect(chatOnOpen({ ...base, continueLast: true })).toBe("t-tab");
        expect(chatOnOpen({ ...base, continueLast: true, tabThread: null })).toBe("t-last");
        expect(chatOnOpen({ ...base, continueLast: true, tabThread: null, lastThread: "" })).toBeNull();
    });

    it("stays new in a tab that asked for a new chat, whatever the setting", () => {
        expect(chatOnOpen({ ...base, continueLast: true, tabThread: "" })).toBeNull();
        expect(chatOnOpen({ ...base, cameBack: true, tabThread: "" })).toBeNull();
    });

    it("keeps the chat on screen when the page reloaded with Polar open", () => {
        expect(chatOnOpen({ ...base, cameBack: true })).toBe("t-tab");
    });

    it("keeps the tab's chat in the extension's per-tab panel, only from this opening", () => {
        expect(chatOnOpen({ ...base, perTab: true })).toBe("t-tab");
        expect(chatOnOpen({ ...base, perTab: true, tabThread: null })).toBeNull();
    });
});

describe("When Polar opens", () => {
    let refuse = false;
    const patches: unknown[] = [];
    beforeEach(() => {
        refuse = false;
        patches.length = 0;
        display.polarDisplayStore.set({ ...POLAR_DISPLAY_DEFAULTS });
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
                if (url === "/api/polar/preferences" && init?.method === "PATCH") {
                    patches.push(JSON.parse(init.body ?? "{}"));
                    return new Response("{}", { status: refuse ? 500 : 200 });
                }
                return new Response(JSON.stringify(display.polarDisplayStore.get()), { status: 200 });
            })
        );
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    const pick = async (name: string) => {
        await userEvent.click(screen.getByRole("combobox", { name: "Start with" }));
        await userEvent.click(await screen.findByRole("option", { name }));
    };

    it("shows a new chat by default and saves the last chat to the account", async () => {
        render(<OpeningSettings />, { wrapper: MessagesWrapper });
        expect(screen.getByText("When Polar opens")).toBeTruthy();
        expect(screen.getByRole("combobox", { name: "Start with" }).textContent).toContain("A new chat");
        await pick("The last chat");
        await waitFor(() => expect(patches).toEqual([{ reopenLastChat: true }]));
        expect(display.polarDisplayStore.get().reopenLastChat).toBe(true);
    });

    it("goes back to a new chat when the server refuses the change", async () => {
        refuse = true;
        render(<OpeningSettings />, { wrapper: MessagesWrapper });
        await pick("The last chat");
        await waitFor(() => expect(patches).toHaveLength(1));
        await waitFor(() => expect(display.polarDisplayStore.get().reopenLastChat).toBe(false));
    });
});
