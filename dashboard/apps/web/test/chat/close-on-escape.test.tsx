// @vitest-environment jsdom

/**
 * Escape closes the conversation - and only when nothing else wanted the key.
 *
 * A dialog, a menu, the emoji picker, the @ list and an edit in progress all
 * close on Escape and say so by taking the key. Closing the conversation behind
 * any of them is never what the press was for.
 */

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VideoViewer } from "@/components/video-viewer";
import { ImageViewer, type ViewedImage } from "@/components/image-viewer";
import { closesConversation, useCloseOnEscape } from "@/app/(app)/chat/close-on-escape";

afterEach(cleanup);

const escape = (init: KeyboardEventInit = {}) =>
    new KeyboardEvent("keydown", { key: "Escape", cancelable: true, ...init });

describe("which presses close the conversation", () => {
    it("a plain Escape with nothing open", () => {
        expect(closesConversation(escape())).toBe(true);
    });

    it("not another key, a held key, or one with a modifier", () => {
        expect(closesConversation(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false);
        expect(closesConversation(escape({ repeat: true }))).toBe(false);
        expect(closesConversation(escape({ shiftKey: true }))).toBe(false);
        expect(closesConversation(escape({ ctrlKey: true }))).toBe(false);
    });

    it("not one something else already took", () => {
        const event = escape();
        event.preventDefault();
        expect(closesConversation(event)).toBe(false);
    });

    it("not while a dialog or a menu is open", () => {
        document.body.innerHTML = `<div role="dialog" data-state="open"></div>`;
        expect(closesConversation(escape())).toBe(false);
        document.body.innerHTML = `<div role="menu" data-state="open"></div>`;
        expect(closesConversation(escape())).toBe(false);
    });

    it("not while a hand-built viewer is open", () => {
        document.body.innerHTML = `<div role="dialog" aria-modal="true"></div>`;
        expect(closesConversation(escape())).toBe(false);
        document.body.innerHTML = "";
    });

    it("despite a submenu kept mounted after it closed", () => {
        document.body.innerHTML = `<div role="menu" data-state="closed" hidden></div>`;
        expect(closesConversation(escape())).toBe(true);
        document.body.innerHTML = "";
    });
});

function Conversation({ onClose }: { onClose: () => void }) {
    const [editing, setEditing] = useState(true);
    useCloseOnEscape(onClose);
    return (
        <input
            aria-label="Message"
            onKeyDown={(event) => {
                // What the composer does with an edit in progress.
                if (event.key === "Escape" && editing) {
                    event.preventDefault();
                    setEditing(false);
                }
            }}
        />
    );
}

describe("the conversation screen", () => {
    it("leaves a picture or a video open over it to close first", () => {
        const onClose = vi.fn();
        const onViewerClose = vi.fn();
        render(
            <>
                <Conversation onClose={onClose} />
                <ImageViewer image={{ url: "/a.png", name: "a.png" } as ViewedImage} onClose={onViewerClose} />
            </>
        );
        window.dispatchEvent(escape());
        expect(onViewerClose).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
        cleanup();

        render(
            <>
                <Conversation onClose={onClose} />
                <VideoViewer src="/a.mp4" onClose={onViewerClose} />
            </>
        );
        window.dispatchEvent(escape());
        expect(onViewerClose).toHaveBeenCalledTimes(2);
        expect(onClose).not.toHaveBeenCalled();
    });


    it("backs out of an edit first, then closes", () => {
        const onClose = vi.fn();
        render(<Conversation onClose={onClose} />);
        const box = screen.getByRole("textbox", { name: "Message" });

        fireEvent.keyDown(box, { key: "Escape" });
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(box, { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("stops listening once it is gone", () => {
        const onClose = vi.fn();
        const { unmount } = render(<Conversation onClose={onClose} />);
        unmount();
        window.dispatchEvent(escape());
        expect(onClose).not.toHaveBeenCalled();
    });
});
