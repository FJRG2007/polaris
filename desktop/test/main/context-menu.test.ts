/**
 * The right-click menu: Electron draws none, so a link, a selection or a text
 * field with nothing here gave no menu at all.
 */

import { describe, expect, it, vi } from "vitest";

const popup = vi.fn();
const buildFromTemplate = vi.fn(() => ({ popup }));
const openExternal = vi.fn();
const writeText = vi.fn();
vi.mock("electron", () => ({ Menu: { buildFromTemplate }, shell: { openExternal }, clipboard: { writeText } }));

const { contextMenuTemplate, installContextMenu, openableLink } = await import("../../src/main/context-menu");

const NO_EDIT = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false, canDelete: false, canEditRichly: false };
const base = { linkURL: "", selectionText: "", isEditable: false, editFlags: NO_EDIT, misspelledWord: "", dictionarySuggestions: [] as string[] };
const actions = () => ({ openExternal: vi.fn(), copyText: vi.fn(), replaceMisspelling: vi.fn() });

describe("contextMenuTemplate", () => {
    it("offers to open and copy a link", () => {
        const spy = actions();
        const items = contextMenuTemplate({ ...base, linkURL: "https://example.com/a?b=1" }, spy);
        expect(items.map((item) => item.label)).toEqual(["Open link in browser", "Copy link"]);
        items[0]?.click?.({} as never, undefined, {} as never);
        items[1]?.click?.({} as never, undefined, {} as never);
        expect(spy.openExternal).toHaveBeenCalledWith("https://example.com/a?b=1");
        expect(spy.copyText).toHaveBeenCalledWith("https://example.com/a?b=1");
    });

    it("copies the address of a mail link, not the scheme", () => {
        const spy = actions();
        const items = contextMenuTemplate({ ...base, linkURL: "mailto:someone@example.com" }, spy);
        items[1]?.click?.({} as never, undefined, {} as never);
        expect(spy.copyText).toHaveBeenCalledWith("someone@example.com");
    });

    it("never hands a script or file address to the system", () => {
        expect(openableLink("javascript:alert(1)")).toBeNull();
        expect(openableLink("file:///etc/passwd")).toBeNull();
        expect(openableLink("not a url")).toBeNull();
        expect(contextMenuTemplate({ ...base, linkURL: "javascript:alert(1)" }, actions())).toEqual([]);
    });

    it("offers copy on selected text, and the edit roles in a field", () => {
        expect(contextMenuTemplate({ ...base, selectionText: "hello" }, actions())).toEqual([{ role: "copy" }]);
        const field = contextMenuTemplate({ ...base, isEditable: true, editFlags: { ...NO_EDIT, canPaste: true } }, actions());
        expect(field.filter((item) => item.role).map((item) => [item.role, item.enabled])).toEqual([
            ["undo", false],
            ["redo", false],
            ["cut", false],
            ["copy", false],
            ["paste", true],
            ["selectAll", false]
        ]);
    });

    it("puts spelling suggestions first in a field", () => {
        const spy = actions();
        const items = contextMenuTemplate({ ...base, isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the", "ten"] }, spy);
        expect(items.slice(0, 3).map((item) => item.label ?? item.type)).toEqual(["the", "ten", "separator"]);
        items[0]?.click?.({} as never, undefined, {} as never);
        expect(spy.replaceMisspelling).toHaveBeenCalledWith("the");
    });

    it("is empty where there is nothing to offer", () => {
        expect(contextMenuTemplate(base, actions())).toEqual([]);
    });
});

describe("installContextMenu", () => {
    it("pops the menu up on a right-click and copies through the clipboard", () => {
        let handler: ((event: unknown, params: typeof base) => void) | undefined;
        const contents = { on: vi.fn((_name: string, fn: typeof handler) => (handler = fn)), replaceMisspelling: vi.fn() };
        installContextMenu(contents as never);
        expect(contents.on).toHaveBeenCalledWith("context-menu", expect.any(Function));
        handler?.({}, { ...base, linkURL: "https://example.com/" });
        expect(popup).toHaveBeenCalledTimes(1);
        const template = (buildFromTemplate.mock.calls[0] as unknown as [{ click?: () => void; }[]])[0];
        template[1]?.click?.();
        expect(writeText).toHaveBeenCalledWith("https://example.com/");
        handler?.({}, base);
        expect(popup).toHaveBeenCalledTimes(1);
    });
});
