// @vitest-environment jsdom

/**
 * The calculator in the search panel: the answer drawn after the sum in the
 * field, Enter, Tab or a tap putting it in place of the sum, and its own button
 * copying it - while Tab and Enter still take a half-typed command.
 */

import { MessagesWrapper } from "../setup/i18n";
import { CommandPalette } from "@/components/command-palette";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.fn();
const show = vi.fn();
const writeText = vi.fn(async (_text: string) => undefined);

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push }),
    usePathname: () => "/home"
}));

vi.mock("@polaris/ui", async (original) => ({
    ...(await original<typeof import("@polaris/ui")>()),
    useToast: () => ({ show, dismiss: vi.fn() })
}));

vi.mock("@/app/(app)/search-actions", () => ({
    clearSearchHistoryAction: vi.fn(async () => ({})),
    forgetSearchAction: vi.fn(async () => ({})),
    listRecentSearchesAction: vi.fn(async () => ({ recent: [] })),
    recordSearchAction: vi.fn(async () => ({}))
}));

vi.mock("@/app/(app)/tour-actions", () => ({
    markOverviewAction: vi.fn(async () => undefined),
    shouldOfferOverviewAction: vi.fn(async () => false)
}));

// jsdom draws nothing, so it has no scrolling to do.
Element.prototype.scrollIntoView = () => undefined;

beforeEach(() => {
    try {
        window.localStorage.clear();
    } catch {
        // No storage in this environment; the panel works without it.
    }
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ hits: [], resources: [] }))
    );
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

async function openField(): Promise<HTMLInputElement> {
    render(<CommandPalette appIds={["deploy", "tasks"]} />, { wrapper: MessagesWrapper });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    return (await screen.findByRole("combobox")) as HTMLInputElement;
}

function ghost(): HTMLElement | null {
    return screen.queryByTestId("search-calculation-ghost");
}

describe("the search panel's calculator", () => {
    it("draws the answer after the sum, out of the field's value and of reach", async () => {
        const field = await openField();
        fireEvent.change(field, { target: { value: "12*3+4" } });

        const drawn = ghost();
        expect(drawn?.getAttribute("aria-hidden")).toBe("true");
        expect(drawn?.textContent).toBe("12*3+4 = 40");
        expect(drawn?.className).toContain("pointer-events-none");
        expect(drawn?.className).toContain("select-none");
        expect(field.value).toBe("12*3+4");

        const options = screen.getAllByRole("option");
        expect(options[0]?.getAttribute("aria-label")).toBe("Use 40");
        expect(screen.getByText("Enter or Tab to use the result")).toBeTruthy();
    });

    it.each(["12*", "abc", "42", "/tasks", "@ana", "1/0"])("draws nothing for %j", async (input) => {
        const field = await openField();
        fireEvent.change(field, { target: { value: input } });
        expect(ghost()).toBeNull();
        expect(screen.queryByRole("option", { name: /^Use / })).toBeNull();
    });

    it("puts the answer in place of the sum on Tab, to go on working with it", async () => {
        const field = await openField();
        fireEvent.change(field, { target: { value: "1,5 * 1000" } });
        const tab = fireEvent.keyDown(field, { key: "Tab" });

        expect(tab).toBe(false);
        expect(field.value).toBe("1500");
        await waitFor(() => expect(field.selectionStart).toBe(4));
        expect(document.activeElement).toBe(field);

        fireEvent.change(field, { target: { value: `${field.value}*2` } });
        expect(ghost()?.textContent).toBe("1500*2 = 3,000");
    });

    it("puts the answer in place of the sum on Enter and on a tap, copying nothing", async () => {
        const field = await openField();
        fireEvent.change(field, { target: { value: "(2+3)^2" } });
        fireEvent.keyDown(field, { key: "Enter" });
        expect(field.value).toBe("25");
        expect(screen.getByRole("combobox")).toBe(field);

        fireEvent.change(field, { target: { value: "10/4" } });
        fireEvent.click(screen.getByRole("option", { name: "Use 2.5" }));
        expect(field.value).toBe("2.5");
        expect(document.activeElement).toBe(field);
        expect(writeText).not.toHaveBeenCalled();
    });

    it("copies the answer from its own button, without using it", async () => {
        const field = await openField();
        fireEvent.change(field, { target: { value: "0.1+0.2" } });
        fireEvent.click(screen.getByRole("button", { name: "Copy 0.3" }));

        expect(writeText).toHaveBeenCalledWith("0.3");
        await waitFor(() =>
            expect(show).toHaveBeenCalledWith(
                expect.objectContaining({ title: "0.3 copied to the clipboard" })
            )
        );
        expect(field.value).toBe("0.1+0.2");
        expect(screen.getByRole("combobox")).toBe(field);
    });

    it("copies the answer on Ctrl+C when nothing in the field is selected", async () => {
        const field = await openField();
        fireEvent.change(field, { target: { value: "15% of 200" } });
        field.setSelectionRange(field.value.length, field.value.length);
        expect(fireEvent.keyDown(field, { key: "c", ctrlKey: true })).toBe(false);
        expect(writeText).toHaveBeenCalledWith("30");

        writeText.mockClear();
        field.setSelectionRange(0, 3);
        expect(fireEvent.keyDown(field, { key: "c", ctrlKey: true })).toBe(true);
        expect(writeText).not.toHaveBeenCalled();
    });

    it("leaves Tab and Enter to a half-typed command", async () => {
        const field = await openField();
        fireEvent.change(field, { target: { value: "/proj" } });
        expect(ghost()).toBeNull();
        expect(fireEvent.keyDown(field, { key: "Tab" })).toBe(false);
        expect(await screen.findByRole("button", { name: /^Stop searching/ })).toBeTruthy();
        expect(field.value).toBe("");

        cleanup();
        const again = await openField();
        fireEvent.change(again, { target: { value: "/proj" } });
        fireEvent.keyDown(again, { key: "Enter" });
        expect(await screen.findByRole("button", { name: /^Stop searching/ })).toBeTruthy();
    });
});
