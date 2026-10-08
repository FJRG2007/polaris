// @vitest-environment jsdom
/**
 * Markdown shortcuts typed on a keyboard where the backtick is a dead key.
 *
 * On a Spanish layout the closing backtick of `this` arrives through a
 * composition rather than as a typed character, and the editor's own rule gave
 * up on it: the message went out with escaped backticks and was drawn as
 * literal text. A real editor is driven here the way the browser drives it -
 * the composed character lands in the document, then `compositionend` fires.
 */

import { Editor } from "@tiptap/core";
import * as md from "@/components/rich-text/markdown";
import { afterEach, describe, expect, it } from "vitest";
import { baseExtensions } from "@/components/rich-text/schema";
import { afterComposition } from "@/components/rich-text/composed-shortcuts";

let editor: Editor | null = null;

afterEach(() => {
    editor?.destroy();
    editor = null;
});

function typedThroughComposition(text: string): Editor {
    editor = new Editor({ element: document.createElement("div"), extensions: baseExtensions("") });
    editor.commands.insertContent(text);
    // ProseMirror goes on calling itself composing for a moment after the
    // browser's event - which is the window the editor's own retry ran in, and
    // what made it give up.
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: text.slice(-1) }));
    const input = (editor.view as unknown as { input: { composing: boolean } }).input;
    input.composing = true;
    setTimeout(() => (input.composing = false), 20);
    return editor;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

describe("a shortcut closed by a dead key", () => {
    it("turns `this` into code once the composition ends", async () => {
        const current = typedThroughComposition("run `test`");
        await settle();
        expect(md.docToMarkdown(current.getJSON())).toBe("run `test`");
        expect(current.getHTML()).toContain("<code>test</code>");
    });

    it("turns ~~this~~ into a strike the same way", async () => {
        const current = typedThroughComposition("a ~~gone~~");
        await settle();
        expect(current.getHTML()).toContain("<s>gone</s>");
    });

    it("leaves a lone backtick alone", async () => {
        const current = typedThroughComposition("use `");
        await settle();
        expect(current.getHTML()).not.toContain("<code>");
        expect(md.docToMarkdown(current.getJSON())).toBe("use \\`");
    });

    it("holds a send that comes straight after until it has applied", async () => {
        const current = typedThroughComposition("x `key`");
        let sent: string | null = null;
        afterComposition(current.view, () => {
            sent = md.docToMarkdown(current.getJSON());
        });
        expect(sent).toBeNull();
        await settle();
        expect(sent).toBe("x `key`");
    });

    it("sends at once when nothing is being composed", () => {
        editor = new Editor({ element: document.createElement("div"), extensions: baseExtensions("") });
        let sent = false;
        afterComposition(editor.view, () => (sent = true));
        expect(sent).toBe(true);
    });
});
