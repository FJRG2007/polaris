// @vitest-environment jsdom

/**
 * The composer keeps every button it always had - attach, photo or video,
 * voice message, clip, poll - with dictation as one more control beside Send,
 * typing into the box on a tap and never sending.
 *
 * The browser's recognizer is a stand-in here; no microphone is opened and no
 * sound is played.
 */

import { MessagesWrapper } from "../setup/i18n";
import { DEFAULT_CHAT_RULES } from "@polaris/core";
import userEvent from "@testing-library/user-event";
import { MicSlot } from "@/app/(app)/chat/mic-slot";
import { Composer } from "@/app/(app)/chat/composer";
import { channelDraftKey, keepDraft } from "@/app/(app)/chat/drafts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    typingAction: async () => undefined
}));

// jsdom does no layout; ProseMirror asks for coordinates anyway.
if (!document.elementFromPoint) document.elementFromPoint = () => null;
if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () =>
        ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;

const stored = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
        clear: () => stored.clear()
    }
});

/** A recognizer that does nothing until the test says something into it. */
class FakeRecognizer {
    static last: FakeRecognizer | null = null;
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    onresult: ((event: unknown) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    onsoundstart: (() => void) | null = null;
    onsoundend: (() => void) | null = null;
    started = false;
    stopped = false;
    constructor() {
        FakeRecognizer.last = this;
    }
    start() {
        this.started = true;
    }
    stop() {
        this.stopped = true;
    }
    abort() {
        this.stopped = true;
    }
    say(text: string, isFinal: boolean) {
        this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] });
    }
}

const KEY = channelDraftKey("c1");

beforeEach(() => {
    window.localStorage.clear();
    // Seen already, so the one-time hint does not sit over the buttons.
    window.localStorage.setItem("polaris.chat.dictation-hint", "1");
    FakeRecognizer.last = null;
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    delete (navigator as { brave?: unknown }).brave;
    Reflect.deleteProperty(navigator, "mediaDevices");
});

function chatBox(extra: Partial<React.ComponentProps<typeof Composer>> = {}) {
    return render(
        <Composer
            channelId="c1"
            draftKey={KEY}
            rules={DEFAULT_CHAT_RULES}
            disabled={false}
            placeholder="Message"
            onSend={() => undefined}
            onPoll={async () => ({})}
            {...extra}
        />,
        { wrapper: MessagesWrapper }
    );
}

function withRecognizer() {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognizer;
}

/** A browser that can record, with a microphone that is never opened. */
function withRecorder() {
    vi.stubGlobal(
        "MediaRecorder",
        class {
            static isTypeSupported = () => true;
        }
    );
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: () => new Promise(() => undefined) }
    });
}

/** Polaris's answer to whether it can transcribe. */
function privateAvailable(available: boolean) {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ available }), { status: 200 }))
    );
}

/** The toolbar's buttons, in the order they are drawn. */
function toolbar(): string[] {
    return screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? "")
        .filter(Boolean);
}

describe("the toolbar", () => {
    it("shows every attach button in its place, with no + menu", async () => {
        withRecorder();
        chatBox();
        await screen.findByRole("button", { name: "Record a voice message" });
        const names = toolbar();
        const order = [
            "Attach a file",
            "Send a photo or video",
            "Record a voice message",
            "Microphone settings",
            "Create a poll"
        ];
        expect(names.filter((name) => order.includes(name))).toEqual(order);
        expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    });

    it("keeps only the poll where files are not allowed", () => {
        withRecorder();
        chatBox({ attachable: false });
        expect(screen.getByRole("button", { name: "Create a poll" })).toBeDefined();
        expect(screen.queryByRole("button", { name: "Attach a file" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Record a voice message" })).toBeNull();
    });

    it("keeps the voice message button beside dictation", async () => {
        withRecorder();
        withRecognizer();
        chatBox();
        await screen.findByRole("button", { name: "Dictate (Alt+M)" });
        expect(screen.getByRole("button", { name: "Record a voice message" })).toBeDefined();
        expect(screen.getByRole("button", { name: "Attach a file" })).toBeDefined();
    });
});

describe("dictation and Send", () => {
    it("is Send alone where there is nothing to dictate with", () => {
        chatBox();
        expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
        expect(screen.queryByRole("button", { name: /Dictate/ })).toBeNull();
    });

    it("shows the dictation button beside Send, with its key in the label", async () => {
        withRecognizer();
        chatBox();
        const mic = await screen.findByRole("button", { name: "Dictate (Alt+M)" });
        expect(mic.getAttribute("aria-pressed")).toBe("false");
        expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
    });

    it("keeps both once there is text", async () => {
        withRecognizer();
        keepDraft(KEY, "already written");
        chatBox();
        await screen.findByRole("button", { name: "Dictate (Alt+M)" });
        expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
    });

    it("dictates with Polaris in Brave, whose recognizer never works", async () => {
        withRecorder();
        withRecognizer();
        privateAvailable(true);
        Object.defineProperty(navigator, "brave", { configurable: true, value: {} });
        // Past the tab's cached answer from the tests before.
        const now = Date.now.bind(Date);
        vi.spyOn(Date, "now").mockImplementation(() => now() + 3_600_000);
        chatBox();
        fireEvent.click(await screen.findByRole("button", { name: "Dictate (Alt+M)" }), {
            detail: 0
        });
        expect(FakeRecognizer.last).toBeNull();
        expect(screen.getByRole("status").textContent).toContain("Listening");
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("keeps the stop button through a switch to Polaris mid-session", async () => {
        withRecorder();
        withRecognizer();
        privateAvailable(true);
        const now = Date.now.bind(Date);
        vi.spyOn(Date, "now").mockImplementation(() => now() + 7_200_000);
        chatBox();
        fireEvent.click(await screen.findByRole("button", { name: "Dictate (Alt+M)" }), {
            detail: 0
        });
        const stops = () =>
            screen
                .queryAllByRole("button", { name: "Stop dictating" })
                .filter((button) => button.getAttribute("aria-pressed") === "true").length;
        const seen: number[] = [];
        const watch = new MutationObserver(() => seen.push(stops()));
        watch.observe(document.body, { childList: true, subtree: true });
        act(() => FakeRecognizer.last!.onerror?.({ error: "service-not-allowed" }));
        await waitFor(() =>
            expect(
                window.localStorage.getItem("polaris.chat.dictation-browser-unusable")
            ).not.toBeNull()
        );
        await act(async () => undefined);
        watch.disconnect();
        expect(stops()).toBe(1);
        expect(seen.every((count) => count === 1)).toBe(true);
        expect(screen.getByRole("status").textContent).toContain("Listening");
        expect(screen.queryByRole("alert")).toBeNull();
    });
});

describe("dictation", () => {
    it("types what is said at the caret, greys what is still a guess, and never sends", async () => {
        withRecognizer();
        const onSend = vi.fn();
        const { container } = chatBox({ onSend });
        const mic = await screen.findByRole("button", { name: "Dictate (Alt+M)" });
        // A keyboard press, which reaches the button as a click with no detail.
        fireEvent.click(mic, { detail: 0 });

        const recognizer = FakeRecognizer.last!;
        expect(recognizer.started).toBe(true);
        expect(recognizer.lang).toBe("en-US");
        expect(recognizer.interimResults).toBe(true);
        expect(screen.getByRole("status").textContent).toContain("Listening");
        expect(
            screen
                .getAllByRole("button", { name: "Stop dictating" })
                .some((button) => button.getAttribute("aria-pressed") === "true")
        ).toBe(true);

        act(() => recognizer.say("hello wor", false));
        expect(screen.getByText("hello wor").className).toContain("italic");

        act(() => recognizer.say("hello world", true));
        await waitFor(() =>
            expect(container.querySelector(".ProseMirror")?.textContent).toContain("hello world")
        );
        expect(screen.queryByText("hello wor")).toBeNull();
        expect(onSend).not.toHaveBeenCalled();
        // Text in the box: Send joins the stop button rather than replacing it.
        expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
    });

    it("stops on Escape", async () => {
        withRecognizer();
        chatBox();
        fireEvent.click(await screen.findByRole("button", { name: "Dictate (Alt+M)" }), {
            detail: 0
        });
        const recognizer = FakeRecognizer.last!;
        fireEvent.keyDown(window, { key: "Escape" });
        expect(recognizer.stopped).toBe(true);
        expect(screen.getByRole("button", { name: "Dictate (Alt+M)" })).toBeDefined();
    });

    it("toggles from Alt+M in the box", async () => {
        withRecognizer();
        const { container } = chatBox();
        await screen.findByRole("button", { name: "Dictate (Alt+M)" });
        const surface = await waitFor(() => {
            const found = container.querySelector<HTMLElement>(".ProseMirror");
            if (!found) throw new Error("the editor did not mount");
            return found;
        });
        fireEvent.keyDown(surface, { key: "m", code: "KeyM", altKey: true });
        expect(FakeRecognizer.last?.started).toBe(true);
        fireEvent.keyDown(surface, { key: "m", code: "KeyM", altKey: true });
        expect(FakeRecognizer.last?.stopped).toBe(true);
    });

    it("says what to do when the microphone is blocked", async () => {
        withRecognizer();
        chatBox();
        fireEvent.click(await screen.findByRole("button", { name: "Dictate (Alt+M)" }), {
            detail: 0
        });
        act(() => FakeRecognizer.last!.onerror?.({ error: "not-allowed" }));
        expect(screen.getByRole("alert").textContent).toContain(
            "Allow it in the browser's site settings"
        );
    });
});

describe("tap and hold on the mic", () => {
    function slot(extra: Partial<React.ComponentProps<typeof MicSlot>> = {}) {
        const calls = {
            onDictate: vi.fn(),
            onVoiceStart: vi.fn(),
            onVoiceStop: vi.fn(),
            onVoiceCancel: vi.fn()
        };
        render(
            <MicSlot
                disabled={false}
                engine="browser"
                voiceAllowed
                dictating={false}
                level={0}
                handheld
                shortcut=""
                menuOpen={false}
                onMenuOpenChange={() => undefined}
                privateChoice={null}
                {...calls}
                {...extra}
            />,
            { wrapper: MessagesWrapper }
        );
        return { calls, mic: screen.getByRole("button", { name: "Dictate" }) };
    }

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("dictates on a tap", () => {
        const { calls, mic } = slot();
        fireEvent.pointerDown(mic, { button: 0, clientX: 0, clientY: 0 });
        fireEvent.pointerUp(mic, { button: 0 });
        expect(calls.onDictate).toHaveBeenCalledTimes(1);
        expect(calls.onVoiceStart).not.toHaveBeenCalled();
    });

    it("records on a hold and sends on release", () => {
        const { calls, mic } = slot();
        fireEvent.pointerDown(mic, { button: 0, clientX: 0, clientY: 0 });
        act(() => void vi.advanceTimersByTime(400));
        expect(calls.onVoiceStart).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("status").textContent).toContain("Slide left to cancel");
        act(() => void vi.advanceTimersByTime(1500));
        fireEvent.pointerUp(mic, { button: 0 });
        expect(calls.onVoiceStop).toHaveBeenCalledTimes(1);
        expect(calls.onDictate).not.toHaveBeenCalled();
    });

    it("throws away a hold released at once, and one slid left", () => {
        const { calls, mic } = slot();
        fireEvent.pointerDown(mic, { button: 0, clientX: 0, clientY: 0 });
        act(() => void vi.advanceTimersByTime(400));
        fireEvent.pointerUp(mic, { button: 0 });
        expect(calls.onVoiceCancel).toHaveBeenCalledTimes(1);

        fireEvent.pointerDown(mic, { button: 0, clientX: 100, clientY: 0 });
        act(() => void vi.advanceTimersByTime(2000));
        fireEvent.pointerMove(mic, { clientX: 0, clientY: 0 });
        expect(calls.onVoiceCancel).toHaveBeenCalledTimes(2);
        expect(calls.onVoiceStop).not.toHaveBeenCalled();
    });

    it("keeps recording after a slide up, with the finger lifted", () => {
        const { calls, mic } = slot();
        fireEvent.pointerDown(mic, { button: 0, clientX: 0, clientY: 100 });
        act(() => void vi.advanceTimersByTime(2000));
        fireEvent.pointerMove(mic, { clientX: 0, clientY: 0 });
        fireEvent.pointerUp(mic, { button: 0 });
        expect(calls.onVoiceStop).not.toHaveBeenCalled();
        expect(calls.onVoiceCancel).not.toHaveBeenCalled();
    });

    it("opens its settings as a sheet on a phone, from the chevron", () => {
        vi.useRealTimers();
        let open = false;
        const { rerender } = render(
            <MicSlot
                disabled={false}
                engine="browser"
                dictating={false}
                level={0}
                handheld
                shortcut=""
                menuOpen={open}
                onMenuOpenChange={(next) => (open = next)}
                onDictate={() => undefined}
                privateChoice={null}
            />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(screen.getByRole("button", { name: "Dictation settings" }));
        expect(open).toBe(true);
        rerender(
            <MicSlot
                disabled={false}
                engine="browser"
                dictating={false}
                level={0}
                handheld
                shortcut=""
                menuOpen
                onMenuOpenChange={(next) => (open = next)}
                onDictate={() => undefined}
                privateChoice={null}
            />
        );
        expect(screen.getByRole("dialog")).toBeDefined();
    });

    it("shows the one-time hint until it is acknowledged", () => {
        window.localStorage.removeItem("polaris.chat.dictation-hint");
        slot();
        expect(screen.getByRole("status").textContent).toContain("Tap to dictate");
        fireEvent.click(screen.getByRole("button", { name: "Got it" }));
        expect(screen.queryByRole("status")).toBeNull();
        expect(window.localStorage.getItem("polaris.chat.dictation-hint")).toBe("1");
    });
});
