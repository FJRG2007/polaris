// @vitest-environment jsdom

/**
 * Translation in a conversation: Translate on a message, live translation of
 * what the others write, and what goes out when the writer sends in another
 * language.
 *
 * Asserted here because each one fails silently: an item drawn for a reader
 * without the Translate app does nothing, a live translation that asks for
 * every line in a long history is a bill nobody sees, and a message sent
 * translated without the writer having seen the translation is words put in
 * their mouth.
 */

import { MessagesWrapper } from "../setup/i18n";
import { DEFAULT_CHAT_RULES } from "@polaris/core";
import userEvent from "@testing-library/user-event";
import type { TranslationOutcome } from "@/lib/text-translation/queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextTranslator } from "@/components/text-translation/provider";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const translator: { current: TextTranslator | null } = { current: null };
vi.mock("@/components/text-translation/provider", () => ({
    useTextTranslator: () => translator.current
}));
vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    typingAction: async () => undefined
}));

import { Composer } from "@/app/(app)/chat/composer";
import { resetMessageTranslations } from "@/app/(app)/chat/message-translation";
import {
    TranslatableText,
    TranslateButton,
    TranslationNote
} from "@/app/(app)/chat/translated-body";

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

/** Every observer made, so a test can say what came into view. */
const observers: Array<{ callback: IntersectionObserverCallback; watched: Element[] }> = [];
class FakeObserver {
    readonly entry: { callback: IntersectionObserverCallback; watched: Element[] };
    constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, watched: [] };
        observers.push(this.entry);
    }
    observe(node: Element) {
        this.entry.watched.push(node);
    }
    disconnect() {
        this.entry.watched = [];
    }
    unobserve() {}
    takeRecords() {
        return [];
    }
}
globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;

function comesIntoView() {
    act(() => {
        for (const one of observers) {
            if (one.watched.length === 0) continue;
            one.callback(
                one.watched.map(
                    (target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry
                ),
                {} as IntersectionObserver
            );
        }
    });
}

function fakeTranslator(answer: (text: string, to: string) => TranslationOutcome) {
    const translate = vi.fn(async (text: string, to: string) => answer(text, to));
    translator.current = { target: "en", translate, openHref: () => "/translate" };
    return translate;
}

const MESSAGE = { id: "m1", body: "Hola a todos", kind: "text", deleted: false };

function Row({ live = false, message = MESSAGE }: { live?: boolean; message?: typeof MESSAGE }) {
    return (
        <div>
            <TranslatableText id={message.id} body={message.body} live={live}>
                <p>{message.body}</p>
            </TranslatableText>
            <TranslationNote id={message.id} body={message.body} translated={undefined} />
            <TranslateButton message={message} />
        </div>
    );
}

beforeEach(() => {
    translator.current = null;
    observers.length = 0;
    resetMessageTranslations();
    window.localStorage.clear();
});
afterEach(cleanup);

describe("Translate on a message", () => {
    it("is not offered without an app that translates", () => {
        render(<Row />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("button", { name: "Translate" })).toBeNull();
    });

    it("is not offered on a deleted message or a notice", () => {
        fakeTranslator(() => ({ kind: "same" }));
        render(
            <>
                <TranslateButton message={{ ...MESSAGE, deleted: true }} />
                <TranslateButton message={{ ...MESSAGE, id: "m2", kind: "system" }} />
            </>,
            { wrapper: MessagesWrapper }
        );
        expect(screen.queryByRole("button", { name: "Translate" })).toBeNull();
    });

    it("shows the translation under the reader's eyes only, with the original a press away", async () => {
        const translate = fakeTranslator(() => ({
            kind: "translated",
            text: "Hello everyone",
            detected: "es"
        }));
        const user = userEvent.setup();
        render(<Row />, { wrapper: MessagesWrapper });

        await user.click(screen.getByRole("button", { name: "Translate" }));
        expect(translate).toHaveBeenCalledWith("Hola a todos", "en");
        expect(await screen.findByText("Hello everyone")).toBeDefined();
        expect(screen.queryByText("Hola a todos")).toBeNull();
        expect(screen.getByText("Translated from Spanish")).toBeDefined();

        await user.click(screen.getAllByRole("button", { name: "Show original" })[0]!);
        expect(screen.getByText("Hola a todos")).toBeDefined();
        expect(screen.getByRole("button", { name: "Show translation" })).toBeDefined();
        expect(translate).toHaveBeenCalledTimes(1);
    });

    it("fails soft, with a note rather than an error", async () => {
        fakeTranslator(() => ({ kind: "failed", message: "No engine" }));
        const user = userEvent.setup();
        render(<Row />, { wrapper: MessagesWrapper });
        await user.click(screen.getByRole("button", { name: "Translate" }));
        expect(await screen.findByText("Could not translate this")).toBeDefined();
        expect(screen.getByText("Hola a todos")).toBeDefined();
    });
});

describe("live translation", () => {
    it("asks only once the message is on screen", async () => {
        const translate = fakeTranslator(() => ({
            kind: "translated",
            text: "Hello everyone",
            detected: "es"
        }));
        render(<Row live />, { wrapper: MessagesWrapper });
        expect(translate).not.toHaveBeenCalled();

        comesIntoView();
        expect(translate).toHaveBeenCalledTimes(1);
        expect(await screen.findByText("Hello everyone")).toBeDefined();
    });

    it("never watches a message it does not translate", () => {
        const translate = fakeTranslator(() => ({ kind: "same" }));
        render(<Row live={false} />, { wrapper: MessagesWrapper });
        comesIntoView();
        expect(observers.every((one) => one.watched.length === 0)).toBe(true);
        expect(translate).not.toHaveBeenCalled();
    });

    it("leaves a message the reader put back to its original", async () => {
        const translate = fakeTranslator(() => ({
            kind: "translated",
            text: "Hello everyone",
            detected: "es"
        }));
        const user = userEvent.setup();
        const first = render(<Row live />, { wrapper: MessagesWrapper });
        comesIntoView();
        await screen.findByText("Hello everyone");
        await user.click(screen.getAllByRole("button", { name: "Show original" })[0]!);
        first.unmount();

        // Scrolled away and back: a new row, the same choice.
        render(<Row live />, { wrapper: MessagesWrapper });
        comesIntoView();
        expect(screen.getByText("Hola a todos")).toBeDefined();
        expect(translate).toHaveBeenCalledTimes(1);
    });
});

/** The editor's surface, once it has mounted. */
async function surface(container: HTMLElement): Promise<HTMLElement> {
    return waitFor(() => {
        const found = container.querySelector<HTMLElement>(".ProseMirror");
        if (!found) throw new Error("the editor did not mount");
        return found;
    });
}

describe("sending in another language", () => {
    function box(onSend: React.ComponentProps<typeof Composer>["onSend"]) {
        return render(
            <Composer
                channelId="c1"
                rules={DEFAULT_CHAT_RULES}
                disabled={false}
                placeholder="Message"
                onSend={onSend}
                translateOutgoing="de"
            />,
            { wrapper: MessagesWrapper }
        );
    }

    it("shows the translation first, and sends it with the words as typed", async () => {
        const translate = fakeTranslator(() => ({
            kind: "translated",
            text: "Guten Morgen",
            detected: "en"
        }));
        const onSend = vi.fn();
        const user = userEvent.setup();
        const { container } = box(onSend);
        expect(screen.getByText("Your messages go out in German")).toBeDefined();

        await user.click(await surface(container));
        await user.keyboard("Good morning");
        await user.click(screen.getByRole("button", { name: "Send" }));

        expect(await screen.findByTestId("outgoing-translation")).toBeDefined();
        expect(screen.getByTestId("outgoing-translation").textContent).toBe("Guten Morgen");
        expect(translate).toHaveBeenCalledWith("Good morning", "de");
        expect(onSend).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Send translation" }));
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
        const call = onSend.mock.calls[0]!;
        expect(call[0]).toBe("Guten Morgen");
        expect(call[6]).toEqual({ from: "en", to: "de", original: "Good morning" });
    });

    it("sends what was written when the writer chooses it", async () => {
        fakeTranslator(() => ({ kind: "translated", text: "Guten Morgen", detected: "en" }));
        const onSend = vi.fn();
        const user = userEvent.setup();
        const { container } = box(onSend);
        await user.click(await surface(container));
        await user.keyboard("Good morning");
        await user.click(screen.getByRole("button", { name: "Send" }));
        await screen.findByTestId("outgoing-translation");

        await user.click(screen.getByRole("button", { name: "Send as written" }));
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
        expect(onSend.mock.calls[0]![0]).toBe("Good morning");
        expect(onSend.mock.calls[0]![6]).toBeUndefined();
    });

    it("sends nothing on a failed translation until the writer chooses", async () => {
        fakeTranslator(() => ({ kind: "failed", message: null }));
        const onSend = vi.fn();
        const user = userEvent.setup();
        const { container } = box(onSend);
        await user.click(await surface(container));
        await user.keyboard("Good morning");
        await user.click(screen.getByRole("button", { name: "Send" }));
        expect(
            await screen.findByText("Could not translate. You can send it as written.")
        ).toBeDefined();
        expect(onSend).not.toHaveBeenCalled();
    });

    it("sends what is in the box when it was already in that language, words typed meanwhile included", async () => {
        let answer: (outcome: TranslationOutcome) => void = () => {};
        const translate = vi.fn((_text: string, _to: string) =>
            translate.mock.calls.length === 1
                ? new Promise<TranslationOutcome>((resolve) => (answer = resolve))
                : Promise.resolve<TranslationOutcome>({ kind: "same" })
        );
        translator.current = { target: "en", translate, openHref: () => "/translate" };
        const onSend = vi.fn();
        const user = userEvent.setup();
        const { container } = box(onSend);
        await user.click(await surface(container));
        await user.keyboard("Guten Morgen");
        await user.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(translate).toHaveBeenCalledTimes(1));

        // Back in the box while the answer is on its way. A click puts the
        // caret at the start, so the new words land in front.
        await user.click(await surface(container));
        await user.keyboard("Hallo ");
        expect(container.textContent).toContain("Hallo Guten Morgen");
        await act(async () => answer({ kind: "same" }));

        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
        expect(onSend.mock.calls[0]![0]).toBe("Hallo Guten Morgen");
        expect(onSend.mock.calls[0]![6]).toBeUndefined();
        // The words added while it waited were asked about too, not waved through.
        expect(translate).toHaveBeenLastCalledWith("Hallo Guten Morgen", "de");
    });

    it("is off without an app that translates", async () => {
        const onSend = vi.fn();
        const user = userEvent.setup();
        const { container } = box(onSend);
        expect(screen.queryByText("Your messages go out in German")).toBeNull();
        await user.click(await surface(container));
        await user.keyboard("Good morning");
        await user.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
        expect(onSend.mock.calls[0]![0]).toBe("Good morning");
    });
});
