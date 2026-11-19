// @vitest-environment jsdom

/**
 * The phone messenger's media flow in the composer: the voice note held to
 * record and slid to cancel or lock, the editor that photos and videos open in
 * before they are sent, and no dictation button of Polaris's own on a phone.
 *
 * No microphone is opened and no picture is decoded.
 */

import { MessagesWrapper } from "../setup/i18n";
import { DEFAULT_CHAT_RULES } from "@polaris/core";
import { Composer } from "@/app/(app)/chat/composer";
import { MediaEditor } from "@/app/(app)/chat/media-editor";
import { VoiceMicButton } from "@/app/(app)/chat/voice-mic-button";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    typingAction: async () => undefined
}));

if (!document.elementFromPoint) document.elementFromPoint = () => null;
if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () =>
        ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("the voice note button", () => {
    function mic(recording = false) {
        const calls = { onStart: vi.fn(), onStop: vi.fn(), onCancel: vi.fn() };
        render(<VoiceMicButton disabled={false} recording={recording} {...calls} />, {
            wrapper: MessagesWrapper
        });
        return { calls, button: screen.getByRole("button", { name: "Record a voice message" }) };
    }

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("starts a hands-free recording on a tap, as a click always has", () => {
        const { calls, button } = mic();
        fireEvent.pointerDown(button, { button: 0, clientX: 0, clientY: 0 });
        fireEvent.pointerUp(button, { button: 0 });
        expect(calls.onStart).toHaveBeenCalledTimes(1);
        expect(calls.onStop).not.toHaveBeenCalled();
    });

    it("records while held and sends on release", () => {
        const { calls, button } = mic();
        fireEvent.pointerDown(button, { button: 0, clientX: 0, clientY: 0 });
        act(() => void vi.advanceTimersByTime(400));
        expect(calls.onStart).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("status").textContent).toContain("Slide left to cancel");
        act(() => void vi.advanceTimersByTime(1500));
        fireEvent.pointerUp(button, { button: 0 });
        expect(calls.onStop).toHaveBeenCalledTimes(1);
        expect(calls.onCancel).not.toHaveBeenCalled();
    });

    it("throws away a slip of the finger and a slide to the left", () => {
        const { calls, button } = mic();
        fireEvent.pointerDown(button, { button: 0, clientX: 0, clientY: 0 });
        act(() => void vi.advanceTimersByTime(400));
        fireEvent.pointerUp(button, { button: 0 });
        expect(calls.onCancel).toHaveBeenCalledTimes(1);

        fireEvent.pointerDown(button, { button: 0, clientX: 200, clientY: 0 });
        act(() => void vi.advanceTimersByTime(2000));
        fireEvent.pointerMove(button, { clientX: 50, clientY: 0 });
        expect(calls.onCancel).toHaveBeenCalledTimes(2);
        expect(calls.onStop).not.toHaveBeenCalled();
    });

    it("keeps recording after a slide up, with the finger lifted", () => {
        const { calls, button } = mic();
        fireEvent.pointerDown(button, { button: 0, clientX: 0, clientY: 100 });
        act(() => void vi.advanceTimersByTime(2000));
        fireEvent.pointerMove(button, { clientX: 0, clientY: 0 });
        fireEvent.pointerUp(button, { button: 0 });
        expect(calls.onStop).not.toHaveBeenCalled();
        expect(calls.onCancel).not.toHaveBeenCalled();
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("cannot start a second recording over a hands-free one", () => {
        const { button } = mic(true);
        expect((button as HTMLButtonElement).disabled).toBe(true);
    });
});

describe("the media editor", () => {
    beforeEach(() => {
        URL.createObjectURL = () => "blob:test";
        URL.revokeObjectURL = () => undefined;
    });

    function editor(extra: Partial<React.ComponentProps<typeof MediaEditor>> = {}) {
        const calls = { onSend: vi.fn(), onRemove: vi.fn(), onClose: vi.fn(), onAdd: vi.fn() };
        const files = [
            new File(["a"], "a.jpg", { type: "image/jpeg" }),
            new File(["b"], "b.mp4", { type: "video/mp4" })
        ];
        render(
            <MediaEditor
                files={files}
                canViewOnce
                refused=""
                captured={() => "gallery"}
                {...calls}
                {...extra}
            />,
            { wrapper: MessagesWrapper }
        );
        return { calls, files };
    }

    it("sends each item with its own caption, to be seen once when the 1 is on", async () => {
        const { calls, files } = editor();
        fireEvent.change(screen.getByRole("textbox", { name: "Add a caption" }), {
            target: { value: "first" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Item 2 of 2" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Add a caption" }), {
            target: { value: "second" }
        });
        const once = screen.getByRole("button", { name: "View once" });
        fireEvent.click(once);
        expect(once.getAttribute("aria-pressed")).toBe("true");
        await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Send" })));
        expect(calls.onSend).toHaveBeenCalledWith(
            [
                { file: files[0], caption: "first", captured: "gallery" },
                { file: files[1], caption: "second", captured: "gallery" }
            ],
            true
        );
    });

    it("offers the tools for a photo and not for a video", () => {
        editor();
        expect(screen.getByRole("button", { name: "Crop and rotate" })).toBeDefined();
        expect(screen.getByRole("button", { name: "Draw" })).toBeDefined();
        fireEvent.click(screen.getByRole("button", { name: "Item 2 of 2" }));
        expect(screen.queryByRole("button", { name: "Draw" })).toBeNull();
    });

    it("has no 1 where the conversation takes nothing seen once", () => {
        editor({ canViewOnce: false });
        expect(screen.queryByRole("button", { name: "View once" })).toBeNull();
    });

    it("removes the item on screen", () => {
        const { calls, files } = editor();
        fireEvent.click(screen.getByRole("button", { name: "Remove this one" }));
        expect(calls.onRemove).toHaveBeenCalledWith(files[0]);
    });
});

describe("dictation on a phone", () => {
    function screenWidth(phone: boolean) {
        const query = (media: string) =>
            ({
                matches: phone && media === "(max-width: 639px)",
                media,
                addEventListener: () => undefined,
                removeEventListener: () => undefined
            }) as unknown as MediaQueryList;
        vi.stubGlobal("matchMedia", query);
    }

    function chatBox() {
        (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = class {
            start() {}
            stop() {}
            abort() {}
        };
        return render(
            <Composer
                channelId="c1"
                rules={DEFAULT_CHAT_RULES}
                disabled={false}
                placeholder="Message"
                onSend={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
    }

    afterEach(() => {
        delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    });

    it("is left to the phone's keyboard", () => {
        screenWidth(true);
        chatBox();
        expect(screen.queryByRole("button", { name: /Dictate/ })).toBeNull();
    });

    it("is offered on a wider screen", async () => {
        screenWidth(false);
        chatBox();
        expect(await screen.findByRole("button", { name: /Dictate/ })).toBeDefined();
    });
});
