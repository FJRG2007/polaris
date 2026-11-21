// @vitest-environment jsdom

/**
 * The bar over a selection is laid outside the editor's own box.
 *
 * It used to go into the editor's parent, and the chat composer clips what
 * overflows it: selecting a word in a message being written showed Bold and
 * Italic cut in half under the line. Now it goes on the page - or on the dialog
 * the editor is in, so a task's editor keeps it inside that dialog's focus trap
 * and the link field in it can still be typed in.
 */

import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it } from "vitest";
import { floatingRoot } from "@/components/rich-text/toolbar";

function editorIn(parent: HTMLElement): Editor {
    const dom = document.createElement("div");
    dom.className = "ProseMirror";
    parent.appendChild(dom);
    return { isDestroyed: false, view: { dom } } as unknown as Editor;
}

afterEach(() => {
    document.body.innerHTML = "";
});

describe("where the selection bar is laid", () => {
    it("is the page for an editor in a box that clips, like the composer", () => {
        const composer = document.createElement("div");
        composer.style.overflow = "hidden";
        document.body.appendChild(composer);
        expect(floatingRoot(editorIn(composer))).toBe(document.body);
    });

    it("is the dialog for an editor inside one", () => {
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        const field = document.createElement("div");
        dialog.appendChild(field);
        document.body.appendChild(dialog);
        expect(floatingRoot(editorIn(field))).toBe(dialog);
    });

    it("is the page once the editor is gone", () => {
        expect(floatingRoot({ isDestroyed: true } as unknown as Editor)).toBe(document.body);
    });
});
