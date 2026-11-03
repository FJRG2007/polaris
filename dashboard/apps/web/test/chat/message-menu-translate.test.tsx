// @vitest-environment jsdom

/**
 * Translate in a message's menu: there only for a reader who has an app that
 * translates, and only on a message with words in it. Pressed, it asks for the
 * reader's own language and the item becomes "Show original".
 */

import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import type { ChatMessageView } from "@/lib/chat/messages";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { TextTranslator } from "@/components/text-translation/provider";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const translator: { current: TextTranslator | null } = { current: null };
vi.mock("@/components/text-translation/provider", () => ({
    useTextTranslator: () => translator.current
}));
vi.mock("@/app/(app)/chat/actions", () => ({ setReminderAction: async () => ({}) }));

import { MessageMenu } from "@/app/(app)/chat/message-menu";
import { resetMessageTranslations } from "@/app/(app)/chat/message-translation";

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
    translator.current = null;
    resetMessageTranslations();
});
afterEach(cleanup);

const MESSAGE = {
    id: "0190a1b2-0000-7000-8000-000000000001",
    channelId: "c1",
    body: "Bonjour",
    kind: "text",
    deleted: false,
    forwardable: true,
    starred: false,
    reactions: [],
    attachments: []
} as unknown as ChatMessageView;

function menu(message: ChatMessageView = MESSAGE) {
    return render(
        <ToastProvider>
            <MessageMenu
                actions={{
                    message,
                    mine: false,
                    canPost: true,
                    canModerate: false,
                    onStar: () => {},
                    onDelete: () => {},
                    onReport: () => {},
                    onExplain: () => {}
                }}
            >
                <p data-testid="text">{message.body}</p>
            </MessageMenu>
        </ToastProvider>,
        { wrapper: MessagesWrapper }
    );
}

const open = () => userEvent.pointer({ keys: "[MouseRight]", target: screen.getByTestId("text") });

describe("Translate in the message menu", () => {
    it("is absent without an app that translates", async () => {
        menu();
        await open();
        expect(await screen.findByText("Copy text")).toBeTruthy();
        expect(screen.queryByText("Translate")).toBeNull();
    });

    it("is absent on a deleted message", async () => {
        translator.current = {
            target: "en",
            translate: async () => ({ kind: "same" }),
            openHref: () => ""
        };
        menu({ ...MESSAGE, deleted: true } as ChatMessageView);
        await open();
        expect(await screen.findByText("Copy message link")).toBeTruthy();
        expect(screen.queryByText("Translate")).toBeNull();
    });

    it("translates into the reader's language and then offers the original", async () => {
        const translate = vi.fn(async () => ({
            kind: "translated" as const,
            text: "Hello",
            detected: "fr"
        }));
        translator.current = { target: "en", translate, openHref: () => "" };
        menu();
        await open();
        await userEvent.click(await screen.findByText("Translate"));
        expect(translate).toHaveBeenCalledWith("Bonjour", "en");

        await open();
        await waitFor(() => expect(screen.getByText("Show original")).toBeTruthy());
        expect(screen.queryByText("Translate")).toBeNull();
    });
});
