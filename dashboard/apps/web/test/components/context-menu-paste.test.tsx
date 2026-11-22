// @vitest-environment jsdom

/**
 * Paste in Polaris's own menus does what Ctrl+V does on the same target.
 *
 * Pinned here: the text lands at the caret the menu was opened on, not where
 * the focus went meanwhile; a picture on the clipboard reaches a composer's
 * attachments through the editor's own paste handling; a field that stops the
 * paste without cancelling it (a terminal) is not typed into a second time; a
 * refused clipboard says so and names the keys; and a browser that can never
 * share it draws Paste disabled with the reason.
 */

import { MessagesWrapper } from "../setup/i18n";
import * as editing from "@/lib/context-menu/editing";
import * as contextMenu from "@/lib/context-menu/target";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/app/(app)/mention-actions", () => ({
    resolveReferencesAction: async () => ({}),
    searchMentionsAction: async () => []
}));

const { ContextMenuFallback } = await import("@/components/context-menu-fallback");
const { RichTextEditor } = await import("@/components/rich-text/rich-text-editor");

/** jsdom has neither; these carry what a browser's do for a paste. */
class FakeDataTransfer {
    private readonly data = new Map<string, string>();
    readonly files: File[] = [];
    readonly items = { add: (file: File) => void this.files.push(file) };
    get types(): string[] {
        return [...this.data.keys(), ...(this.files.length > 0 ? ["Files"] : [])];
    }
    setData(type: string, value: string): void {
        this.data.set(type, value);
    }
    getData(type: string): string {
        return this.data.get(type) ?? "";
    }
}

class FakeClipboardEvent extends Event {
    readonly clipboardData: FakeDataTransfer | null;
    constructor(type: string, init: EventInit & { clipboardData?: FakeDataTransfer } = {}) {
        super(type, init);
        this.clipboardData = init.clipboardData ?? null;
    }
}

function item(entries: Record<string, Blob>) {
    return { types: Object.keys(entries), getType: async (type: string) => entries[type] };
}

function clipboard(value: Partial<Clipboard> | undefined) {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

const denied = () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));

beforeEach(() => {
    vi.stubGlobal("DataTransfer", FakeDataTransfer);
    vi.stubGlobal("ClipboardEvent", FakeClipboardEvent);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    contextMenu.setContextMenuNotice(null);
    clipboard({ readText: async () => "", writeText: async () => undefined });
});

describe("pasting from a menu", () => {
    it("types the text at the caret the menu was opened on", async () => {
        clipboard({ read: async () => [item({ "text/plain": new Blob([", there"], { type: "text/plain" }) })] as never });
        document.body.innerHTML = `<textarea id="f">hello world</textarea><button id="other">x</button>`;
        const field = document.getElementById("f") as HTMLTextAreaElement;
        const saved: [number, number] = [5, 5];
        // The menu took the focus and the caret moved on while it was open.
        field.setSelectionRange(11, 11);
        (document.getElementById("other") as HTMLElement).focus();

        const outcome = await editing.pasteFromClipboard(field, {
            restore: () => {
                field.focus();
                field.setSelectionRange(...saved);
            }
        });

        expect(outcome).toBe("typed");
        expect(field.value).toBe("hello, there world");
    });

    it("does not type the text again into a field that stopped the paste", async () => {
        clipboard({ readText: async () => "ls -la" });
        document.body.innerHTML = `<textarea id="f"></textarea>`;
        const field = document.getElementById("f") as HTMLTextAreaElement;
        const sent: string[] = [];
        field.addEventListener("paste", (event) => {
            sent.push((event as ClipboardEvent).clipboardData!.getData("text/plain"));
            event.stopPropagation();
        });

        expect(await editing.pasteFromClipboard(field)).toBe("taken");
        expect(sent).toEqual(["ls -la"]);
        expect(field.value).toBe("");
    });

    it("hands a copied picture to the composer's attachments, as Ctrl+V does", async () => {
        const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
        clipboard({ read: async () => [item({ "image/png": png })] as never });
        const onPasteFiles = vi.fn(() => true);
        const onChange = vi.fn();
        const { container } = render(
            <RichTextEditor value="" onChange={onChange} framed onPasteFiles={onPasteFiles} />,
            { wrapper: MessagesWrapper }
        );
        const surface = await waitFor(() => {
            const found = container.querySelector(".ProseMirror");
            expect(found).toBeTruthy();
            return found!;
        });

        let outcome: editing.MenuPasteOutcome | null = null;
        await act(async () => {
            outcome = await editing.pasteFromClipboard(surface);
        });

        expect(outcome).toBe("taken");
        expect(onPasteFiles).toHaveBeenCalledTimes(1);
        const files = (onPasteFiles.mock.calls[0] as unknown as [File[]])[0];
        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({ type: "image/png", name: "image.png" });
    });

    it("says the clipboard was refused and names the keys", async () => {
        clipboard({ read: denied, readText: denied, writeText: async () => undefined });
        const notices: string[] = [];
        render(
            <>
                <ContextMenuFallback />
                <textarea data-testid="field" defaultValue="hello" />
            </>,
            { wrapper: MessagesWrapper }
        );
        contextMenu.setContextMenuNotice((title) => notices.push(title));
        const field = screen.getByTestId("field");
        act(() => {
            field.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 4, clientY: 4 }));
        });
        fireEvent.click(screen.getByRole("menuitem", { name: /^Paste/ }));

        await waitFor(() => expect(notices).toHaveLength(1));
        expect(notices[0]).toMatch(/clipboard/i);
        expect(notices[0]).toMatch(/Ctrl\+V|Cmd\+V/);
        expect((field as HTMLTextAreaElement).value).toBe("hello");
    });

    it("draws Paste disabled with the reason where the clipboard can never be read", () => {
        clipboard(undefined);
        render(
            <>
                <ContextMenuFallback />
                <textarea data-testid="field" />
            </>,
            { wrapper: MessagesWrapper }
        );
        act(() => {
            screen
                .getByTestId("field")
                .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 4, clientY: 4 }));
        });
        expect(screen.getByRole("menuitem", { name: /^Paste/ }).getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText(/Clipboard blocked here\. Press (Ctrl|Cmd)\+V\./)).toBeTruthy();
    });
});
