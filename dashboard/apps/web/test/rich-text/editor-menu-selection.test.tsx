// @vitest-environment jsdom

/**
 * The right-press menu acts on the selection that was there when it opened.
 *
 * Tiptap does not re-render a React tree when the selection changes - that is off
 * by default, because it would cost a render on every keystroke - and dragging
 * across a word changes nothing else either. So the menu was reading its own state
 * during a render that had already happened, back when nothing was selected: Copy
 * came up disabled, a disabled item takes no pointer, and pressing it did nothing
 * at all. Nothing ever reached the clipboard. That is the report this exists for.
 *
 * **The clipboard here does not answer, and that is the whole test.** The menu
 * asks what is on the clipboard as it opens, and an answer re-renders it - which
 * hides the defect behind a lucky second render. A browser does not answer
 * promptly: the first `readText` of a page is a permission the reader is being
 * asked for, and until they answer it the promise is simply pending. Everything
 * below is what somebody sees during that window, which is the window they are
 * pressing Copy in.
 *
 * The editor is a stand-in on purpose. What is pinned is *when* the menu reads the
 * selection rather than what tiptap does with one, and a stand-in is the only way
 * to move a selection without re-rendering React as well - precisely the case that
 * was broken.
 */

import type { Editor } from "@tiptap/react";
import { EditorMenu } from "@/components/rich-text/editor-menu";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const writeText = vi.fn(async () => undefined);
/** Asked on the way open, and still thinking - see the note above. */
const readText = vi.fn(() => new Promise<string>(() => {}));

beforeAll(() => {
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText, readText }
    });
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

beforeEach(() => {
    writeText.mockClear();
    readText.mockClear();
});

afterEach(cleanup);

const TEXT = "hello world";

/** Every range the menu asked to be taken out, and every span it marked. */
interface Done {
    readonly deleted: { from: number; to: number }[];
    readonly marked: { from: number; to: number; command: string }[];
}

/**
 * An editor whose selection moves without React hearing about it, which is what a
 * mouse drag across a real one does.
 *
 * Its text is replaceable, because the other thing that happens behind the menu's
 * back is the document itself being swapped: the menu holds the focus, and a
 * blurred surface is the one a value from the server is allowed to replace.
 */
function standIn(): {
    editor: Editor;
    select: (from: number, to: number) => void;
    replace: (text: string) => void;
    done: Done;
} {
    const selection = { from: 1, to: 1 };
    const done: Done = { deleted: [], marked: [] };
    let text = TEXT;
    const editor = {
        isDestroyed: false,
        state: {
            get selection() {
                return { ...selection, empty: selection.from === selection.to };
            },
            doc: {
                // Document positions start at one, so the slice sits one to the left.
                textBetween: (from: number, to: number) => text.slice(from - 1, to - 1),
                get content() {
                    return { size: text.length + 1 };
                }
            }
        },
        chain: () => {
            let at = { from: 0, to: 0 };
            const mark = (command: string) => () => {
                done.marked.push({ ...at, command });
                return chain;
            };
            const chain = {
                focus: () => chain,
                deleteRange: (range: { from: number; to: number }) => {
                    done.deleted.push(range);
                    return chain;
                },
                setTextSelection: (range: { from: number; to: number }) => {
                    at = range;
                    return chain;
                },
                toggleBold: mark("toggleBold"),
                toggleItalic: mark("toggleItalic"),
                toggleStrike: mark("toggleStrike"),
                toggleCode: mark("toggleCode"),
                run: () => true
            };
            return chain;
        }
    };
    return {
        editor: editor as unknown as Editor,
        select: (from, to) => {
            selection.from = from;
            selection.to = to;
        },
        replace: (next) => {
            text = next;
        },
        done
    };
}

function draw(editor: Editor): void {
    render(
        <EditorMenu editor={editor}>
            <div data-testid="surface">{TEXT}</div>
        </EditorMenu>
    );
}

/** Right-press the writing surface. */
async function openMenu(): Promise<void> {
    await act(async () => {
        fireEvent.contextMenu(screen.getByTestId("surface"));
    });
}

/** A row of the open menu, by the label it carries. */
function row(name: RegExp): HTMLElement {
    return screen.getByRole("menuitem", { name });
}

/** Press a row and let the clipboard answer it. */
async function press(name: RegExp): Promise<void> {
    await act(async () => {
        fireEvent.click(row(name));
    });
}

/** Right-press the writing surface, and hand back the row that copies. */
async function openCopy(): Promise<HTMLElement> {
    await openMenu();
    return row(/^Copy/);
}

describe("copying out of the right-press menu", () => {
    it("offers the selection React never saw", async () => {
        const { editor, select } = standIn();
        draw(editor);
        // The mouse drag: the selection moves and nothing re-renders.
        select(1, 6);
        expect((await openCopy()).getAttribute("aria-disabled")).not.toBe("true");
    });

    it("puts that selection on the clipboard", async () => {
        const { editor, select } = standIn();
        draw(editor);
        select(1, 6);
        fireEvent.click(await openCopy());
        expect(writeText).toHaveBeenCalledWith("hello");
    });

    it("copies what it was opened over, not what is selected by the time it is read", async () => {
        // The menu takes the focus when it opens, and an editor that lets its
        // selection go with the focus would otherwise have Copy write an empty
        // string over whatever was on the clipboard.
        const { editor, select } = standIn();
        draw(editor);
        select(1, 6);
        const copy = await openCopy();
        select(1, 1);
        fireEvent.click(copy);
        expect(writeText).toHaveBeenCalledWith("hello");
    });

    it("stays out of reach while nothing is selected", async () => {
        const { editor } = standIn();
        draw(editor);
        expect((await openCopy()).getAttribute("aria-disabled")).toBe("true");
    });
});

/**
 * The other half of a captured span: it is a pair of absolute positions, and the
 * document underneath it is free to move while the clipboard is being written.
 * The menu holds the focus, and a blurred surface is precisely the one the editor
 * lets a value from the server replace, so this is the ordinary case rather than
 * an exotic one. What the numbers no longer describe must be left alone.
 */
describe("cutting out of the right-press menu", () => {
    it("takes out the span it was opened over", async () => {
        const { editor, select, done } = standIn();
        draw(editor);
        select(1, 6);
        await openMenu();
        await press(/^Cut/);
        expect(done.deleted).toEqual([{ from: 1, to: 6 }]);
    });

    it("leaves the text alone when the document moved while the clipboard answered", async () => {
        const { editor, select, replace, done } = standIn();
        draw(editor);
        select(1, 6);
        await openMenu();
        writeText.mockImplementationOnce(async () => {
            replace("a description saved from somewhere else");
            return undefined;
        });
        await press(/^Cut/);
        expect(done.deleted).toEqual([]);
    });

    it("leaves the text alone when the document no longer reaches that far", async () => {
        const { editor, select, replace, done } = standIn();
        draw(editor);
        select(1, 6);
        await openMenu();
        // Shorter than the span: deleting by these positions is what threw.
        writeText.mockImplementationOnce(async () => {
            replace("hi");
            return undefined;
        });
        await press(/^Cut/);
        expect(done.deleted).toEqual([]);
    });
});

describe("marking out of the right-press menu", () => {
    it("marks the span it was opened over, not the caret it was left with", async () => {
        const { editor, select, done } = standIn();
        draw(editor);
        select(1, 6);
        await openMenu();
        select(1, 1);
        await press(/^Bold/);
        expect(done.marked).toEqual([{ from: 1, to: 6, command: "toggleBold" }]);
    });

    it("marks nothing once the document moved under the span", async () => {
        const { editor, select, replace, done } = standIn();
        draw(editor);
        select(1, 6);
        await openMenu();
        replace("hi");
        await press(/^Italic/);
        expect(done.marked).toEqual([]);
    });
});
