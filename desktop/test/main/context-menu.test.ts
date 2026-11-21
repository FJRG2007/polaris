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

const { contextMenuTemplate, installContextMenu, linkInSelection, openableLink, searchAddress, searchLabel } = await import("../../src/main/context-menu");

const NO_EDIT = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false, canDelete: false, canEditRichly: false };
const base = { linkURL: "", selectionText: "", isEditable: false, editFlags: NO_EDIT, misspelledWord: "", dictionarySuggestions: [] as string[], mediaType: "none" as const, srcURL: "", hasImageContents: false, formControlType: "none" as "none" | "input-password" };
const actions = () => ({ openExternal: vi.fn(), copyText: vi.fn(), replaceMisspelling: vi.fn(), addToDictionary: vi.fn(), copyImage: vi.fn(), saveImage: vi.fn() });
const labels = (items: { label?: string; role?: string; type?: string; }[]) => items.map((item) => item.label ?? item.role ?? item.type);

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
        expect(labels(contextMenuTemplate({ ...base, selectionText: "hello" }, actions()))).toEqual(["copy", 'Search Google for "hello"']);
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
        expect(labels(items.slice(0, 5))).toEqual(["the", "ten", "separator", "Add to dictionary", "separator"]);
        items[0]?.click?.({} as never, undefined, {} as never);
        expect(spy.replaceMisspelling).toHaveBeenCalledWith("the");
        items[3]?.click?.({} as never, undefined, {} as never);
        expect(spy.addToDictionary).toHaveBeenCalledWith("teh");
    });

    it("says there is no suggestion rather than offering none", () => {
        const items = contextMenuTemplate({ ...base, isEditable: true, misspelledWord: "qzxv" }, actions());
        expect(items[0]).toEqual({ label: "No spelling suggestions", enabled: false });
        expect(items[2]?.label).toBe("Add to dictionary");
    });

    it("offers to copy and save an image", () => {
        const spy = actions();
        const items = contextMenuTemplate({ ...base, mediaType: "image", srcURL: "https://example.com/a.png", hasImageContents: true }, spy);
        expect(labels(items)).toEqual(["Copy image", "Copy image address", "Save image as..."]);
        items.forEach((item) => item.click?.({} as never, undefined, {} as never));
        expect(spy.copyImage).toHaveBeenCalledTimes(1);
        expect(spy.copyText).toHaveBeenCalledWith("https://example.com/a.png");
        expect(spy.saveImage).toHaveBeenCalledWith("https://example.com/a.png");
    });

    it("has no address to copy for an inline image, and nothing to save from another scheme", () => {
        expect(labels(contextMenuTemplate({ ...base, mediaType: "image", srcURL: "data:image/png;base64,AAAA", hasImageContents: true }, actions()))).toEqual(["Copy image", "Save image as..."]);
        expect(contextMenuTemplate({ ...base, mediaType: "image", srcURL: "file:///etc/passwd", hasImageContents: false }, actions())).toEqual([]);
    });

    it("puts the link before the image when the image is a link", () => {
        const items = contextMenuTemplate({ ...base, linkURL: "https://example.com/", mediaType: "image", srcURL: "https://example.com/a.png", hasImageContents: true }, actions());
        expect(labels(items)).toEqual(["Open link in browser", "Copy link", "separator", "Copy image", "Copy image address", "Save image as..."]);
    });

    it("searches a selection, in a field too, but never a password", () => {
        const spy = actions();
        const items = contextMenuTemplate({ ...base, selectionText: "  polar\n star " }, spy);
        items[1]?.click?.({} as never, undefined, {} as never);
        expect(spy.openExternal).toHaveBeenCalledWith("https://www.google.com/search?q=polar%20star");
        const field = contextMenuTemplate({ ...base, isEditable: true, selectionText: "word" }, actions());
        expect(labels(field)[0]).toBe('Search Google for "word"');
        const password = contextMenuTemplate({ ...base, isEditable: true, selectionText: "hunter2", formControlType: "input-password" }, actions());
        expect(labels(password).some((label) => label?.startsWith("Search"))).toBe(false);
    });

    it("is empty where there is nothing to offer", () => {
        expect(contextMenuTemplate(base, actions())).toEqual([]);
    });
});

describe("searchLabel", () => {
    it("keeps a long selection on one short line", () => {
        expect(searchLabel("a\n  b")).toBe('Search Google for "a b"');
        expect(searchLabel("x".repeat(80))).toBe(`Search Google for "${"x".repeat(27)}..."`);
        expect(searchAddress("a&b=c")).toBe("https://www.google.com/search?q=a%26b%3Dc");
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

describe("a selected address", () => {
    it("is offered as a link when the whole selection is one", () => {
        const spy = actions();
        const url = "https://cursor.com/loginDeepControl?challenge=abc&uuid=1&mode=login&redirectTarget=cli";
        const items = contextMenuTemplate({ ...base, selectionText: `  ${url}
` }, spy);
        expect(items.map((item) => item.label ?? item.role ?? item.type)).toEqual(["Open link in browser", "Copy link", "separator", "copy"]);
        items[0]?.click?.({} as never, undefined, {} as never);
        expect(spy.openExternal).toHaveBeenCalledWith(url);
    });

    it("drops the punctuation of the sentence it was printed in", () => {
        expect(linkInSelection("https://example.com/a).")).toBe("https://example.com/a");
    });

    it("is not a link when it is a sentence, another scheme, or nothing", () => {
        expect(linkInSelection("open https://example.com now")).toBeNull();
        expect(linkInSelection("file:///etc/passwd")).toBeNull();
        expect(linkInSelection("javascript:alert(1)")).toBeNull();
        expect(linkInSelection("note: done")).toBeNull();
        expect(linkInSelection("")).toBeNull();
    });
});
describe("the editing bridge's checks", async () => {
    const { clipboardText, dictionaryWord, pagePoint, savableImageUrl, CLIPBOARD_TEXT_MAX } = await import("../../src/main/context-menu");

    it("adds only a single word to the dictionary", () => {
        expect(dictionaryWord("  Polaris ")).toBe("Polaris");
        expect(dictionaryWord("don\u2019t")).toBe("don\u2019t");
        expect(dictionaryWord("cami\u00f3n")).toBe("cami\u00f3n");
        expect(dictionaryWord("two words")).toBeNull();
        expect(dictionaryWord("")).toBeNull();
        expect(dictionaryWord("a".repeat(65))).toBeNull();
        expect(dictionaryWord(42)).toBeNull();
    });

    it("refuses clipboard text that is not text or is far too long", () => {
        expect(clipboardText("hello")).toBe("hello");
        expect(clipboardText("")).toBe("");
        expect(clipboardText(null)).toBeNull();
        expect(clipboardText("x".repeat(CLIPBOARD_TEXT_MAX + 1))).toBeNull();
    });

    it("scales a page point by the zoom and refuses anything else", () => {
        expect(pagePoint(10.4, 20, 1.5)).toEqual({ x: 16, y: 30 });
        expect(pagePoint(-1, 2, 1)).toBeNull();
        expect(pagePoint(Number.NaN, 2, 1)).toBeNull();
        expect(pagePoint("1", 2, 1)).toBeNull();
        expect(pagePoint(1, 2, 0)).toBeNull();
    });

    it("saves only pictures from an address or inline", () => {
        expect(savableImageUrl("https://example.com/a.png")).toBe("https://example.com/a.png");
        expect(savableImageUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
        expect(savableImageUrl("file:///C:/Windows/win.ini")).toBeNull();
        expect(savableImageUrl("chrome://settings")).toBeNull();
        expect(savableImageUrl(undefined)).toBeNull();
    });
});
