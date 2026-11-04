// @vitest-environment jsdom

/**
 * A forward's note follows each destination's outgoing language.
 *
 * The composer never sends words translated unseen, and the forward dialog is
 * the other place this person writes into a conversation. So a note forwarded
 * to a room that sends in German is translated, shown, and only then sent -
 * with the record of what was typed - while a destination with no outgoing
 * language, one already in that language, or one whose translation failed gets
 * the note exactly as written and no record.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import type { ChatMessageView } from "@/lib/chat/messages";
import { ForwardDialog } from "@/app/(app)/chat/forward-dialog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { TextTranslator } from "@/components/text-translation/provider";

const forwardAction = vi.fn(async (_input: unknown) => ({ id: "sent" }));
vi.mock("@/app/(app)/chat/actions", () => ({
    forwardAction: (input: unknown) => forwardAction(input)
}));

const translator: { current: TextTranslator | null } = { current: null };
vi.mock("@/components/text-translation/provider", () => ({
    useTextTranslator: () => translator.current
}));

function dm(id: string, name: string, outgoing: string | null) {
    return {
        id,
        spaceId: null,
        categoryId: null,
        kind: "dm",
        name,
        archived: false,
        others: [{ id: name.toLowerCase(), name }],
        translation: { incoming: false, outgoing }
    };
}

vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        channels: [dm("c1", "Grace", "de"), dm("c2", "Ada", "de"), dm("c3", "Alan", null)],
        spaces: []
    })
}));

const MESSAGE = {
    id: "m1",
    channelId: "origin",
    authorId: "someone",
    authorName: "Someone",
    kind: "text",
    body: "the message",
    parentId: null,
    replyCount: 0,
    lastReplyAt: null,
    edited: false,
    deleted: false,
    reactions: [],
    attachments: [],
    quote: null,
    starred: false,
    forwardable: true,
    link: null,
    preview: null,
    previewPending: false,
    receipt: null,
    createdAt: new Date(1_700_000_000_000).toISOString()
} as unknown as ChatMessageView;

function setTranslator(
    answer: (text: string, to: string) => ReturnType<TextTranslator["translate"]>
) {
    const translate = vi.fn(answer);
    translator.current = { translate } as unknown as TextTranslator;
    return translate;
}

async function forwardNote(names: readonly RegExp[], note: string) {
    const user = userEvent.setup();
    const sent = vi.fn();
    render(<ForwardDialog message={MESSAGE} onOpenChange={() => undefined} onSent={sent} />, {
        wrapper: MessagesWrapper
    });
    for (const name of names) await user.click(screen.getByRole("button", { name }));
    await user.type(screen.getByLabelText("Say something about it"), note);
    await user.click(screen.getByRole("button", { name: /^Forward/ }));
    return { user, sent };
}

beforeEach(() => {
    forwardAction.mockClear();
    translator.current = null;
});
afterEach(cleanup);

describe("a forward's note sent where messages go out in another language", () => {
    it("is translated once per language, shown, and sent with its record", async () => {
        const translate = setTranslator(async (text) => ({
            kind: "translated",
            text: `DE ${text}`,
            detected: "en"
        }));
        const { user, sent } = await forwardNote([/Grace$/, /Ada$/, /Alan$/], "look at this");

        expect(await screen.findByTestId("forward-note-translation")).toHaveProperty(
            "textContent",
            "DE look at this"
        );
        // Two destinations in German, one translation asked.
        expect(translate).toHaveBeenCalledTimes(1);
        // Nothing has gone while the translation is only on screen.
        expect(forwardAction).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Send translation" }));
        await waitFor(() => expect(forwardAction).toHaveBeenCalledTimes(3));
        const record = { from: "en", to: "de", original: "look at this" };
        expect(forwardAction).toHaveBeenCalledWith({
            messageId: "m1",
            channelId: "c1",
            note: "DE look at this",
            translation: record
        });
        expect(forwardAction).toHaveBeenCalledWith({
            messageId: "m1",
            channelId: "c2",
            note: "DE look at this",
            translation: record
        });
        expect(forwardAction).toHaveBeenCalledWith({
            messageId: "m1",
            channelId: "c3",
            note: "look at this"
        });
        expect(sent).toHaveBeenCalled();
    });

    it("goes as written everywhere when that is chosen instead", async () => {
        setTranslator(async (text) => ({ kind: "translated", text: `DE ${text}`, detected: "en" }));
        const { user } = await forwardNote([/Grace$/], "look at this");
        await screen.findByTestId("forward-note-translation");

        await user.click(screen.getByRole("button", { name: "Send as written" }));
        await waitFor(() => expect(forwardAction).toHaveBeenCalledTimes(1));
        expect(forwardAction).toHaveBeenCalledWith({
            messageId: "m1",
            channelId: "c1",
            note: "look at this"
        });
    });

    it("is sent straight away and with no record when it is already in that language", async () => {
        setTranslator(async () => ({ kind: "same" }));
        await forwardNote([/Grace$/], "schau mal");

        await waitFor(() => expect(forwardAction).toHaveBeenCalledTimes(1));
        expect(forwardAction).toHaveBeenCalledWith({
            messageId: "m1",
            channelId: "c1",
            note: "schau mal"
        });
        expect(screen.queryByTestId("forward-note-translation")).toBeNull();
    });

    it("says a failed translation and offers only to send it as written", async () => {
        setTranslator(async () => ({ kind: "failed", message: null }));
        const { user } = await forwardNote([/Grace$/], "look at this");

        expect(await screen.findByText(/Not translated for Grace/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Send translation" })).toBeNull();
        expect(forwardAction).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Send as written" }));
        await waitFor(() => expect(forwardAction).toHaveBeenCalledTimes(1));
        expect(forwardAction).toHaveBeenCalledWith({
            messageId: "m1",
            channelId: "c1",
            note: "look at this"
        });
    });

    it("drops the translation shown once the note is changed", async () => {
        setTranslator(async (text) => ({ kind: "translated", text: `DE ${text}`, detected: "en" }));
        const { user } = await forwardNote([/Grace$/], "look at this");
        await screen.findByTestId("forward-note-translation");

        await user.type(screen.getByLabelText("Say something about it"), " too");
        expect(screen.queryByTestId("forward-note-translation")).toBeNull();
        expect(forwardAction).not.toHaveBeenCalled();
    });

    it("sends the note untouched where nothing translates", async () => {
        await forwardNote([/Grace$/], "look at this");

        await waitFor(() => expect(forwardAction).toHaveBeenCalledTimes(1));
        expect(forwardAction).toHaveBeenCalledWith({
            messageId: "m1",
            channelId: "c1",
            note: "look at this"
        });
    });
});
