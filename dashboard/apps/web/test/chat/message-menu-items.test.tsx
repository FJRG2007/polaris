// @vitest-environment jsdom

/**
 * What the message menu lists, by what was right-clicked.
 *
 * A file's download belongs to the file: right-clicking the words of a message
 * with attachments shows the message's own items and no downloads, and
 * right-clicking one attachment offers that one. The reaction row at the top
 * makes the same press the hover bar makes, and "Remind me" offers its presets.
 */

import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import type { ChatMessageView } from "@/lib/chat/messages";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MessageMenu, type MessageActions } from "@/app/(app)/chat/message-menu";

const setReminderAction = vi.fn(async (input: { dueAt: string }) => ({ dueAt: input.dueAt }));
vi.mock("@/app/(app)/chat/actions", () => ({
    setReminderAction: (input: { dueAt: string }) => setReminderAction(input)
}));

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
    cleanup();
    setReminderAction.mockClear();
});

const MESSAGE = {
    id: "0190a1b2-0000-7000-8000-000000000001",
    channelId: "c1",
    body: "Here are the files",
    kind: "text",
    deleted: false,
    forwardable: true,
    starred: false,
    reactions: [],
    attachments: [
        { id: "f1", name: "plan.pdf", contentType: "application/pdf", size: 10 },
        { id: "f2", name: "notes.zip", contentType: "application/zip", size: 10 },
        { id: "a1", name: "voice.webm", contentType: "audio/webm", size: 10 }
    ]
} as unknown as ChatMessageView;

function menu(extra: Partial<MessageActions> = {}) {
    return render(
        <ToastProvider>
            <MessageMenu
                actions={{
                    message: MESSAGE,
                    mine: false,
                    canPost: true,
                    canModerate: false,
                    onReply: () => {},
                    onStar: () => {},
                    onDelete: () => {},
                    onReport: () => {},
                    onExplain: () => {},
                    ...extra
                }}
            >
                <div data-testid="row">
                    <p data-testid="text">Here are the files</p>
                    <ul>
                        <li data-attachment="f1">
                            <span data-testid="pdf">plan.pdf</span>
                        </li>
                        <li data-attachment="f2">
                            <span data-testid="zip">notes.zip</span>
                        </li>
                        <li data-attachment="a1">
                            <button type="button" data-testid="voice">
                                play
                            </button>
                        </li>
                    </ul>
                </div>
            </MessageMenu>
        </ToastProvider>,
        { wrapper: MessagesWrapper }
    );
}

const open = (testId: string) =>
    userEvent.pointer({ keys: "[MouseRight]", target: screen.getByTestId(testId) });

describe("the message menu by target", () => {
    it("lists no downloads over the text of the message", async () => {
        menu();
        await open("text");
        expect(await screen.findByText("Copy text")).toBeTruthy();
        expect(screen.queryByText("Download")).toBeNull();
        expect(screen.queryByText("Download the audio")).toBeNull();
    });

    it("offers the one file that was right-clicked", async () => {
        menu();
        await open("zip");
        const item = await screen.findByText("Download");
        expect(item.closest("a")?.getAttribute("href")).toBe("/api/chat/attachments/f2?download=1");
        expect(screen.getAllByText("Download")).toHaveLength(1);
        expect(screen.queryByText("Download the audio")).toBeNull();
        // The message's own items are still there underneath.
        expect(screen.getByText("Copy text")).toBeTruthy();
    });

    it("offers the recording's formats over a voice note, and nothing else to save", async () => {
        menu();
        await open("voice");
        expect(await screen.findByText("Download the audio")).toBeTruthy();
        expect(screen.queryByText("Download")).toBeNull();
    });
});

describe("reactions in the menu", () => {
    it("reacts through the same action the hover bar uses", async () => {
        const onReact = vi.fn();
        menu({ onReact, quick: ["👍", "❤️", "😄", "🎉"] });
        await open("text");
        const faces = await screen.findAllByLabelText(/^React with/);
        expect(faces).toHaveLength(4);
        await userEvent.click(faces[3]!);
        expect(onReact).toHaveBeenCalledWith(MESSAGE.id, "🎉");
    });

    it("opens the full picker from Add reaction", async () => {
        const onAddReaction = vi.fn();
        menu({ onReact: () => {}, quick: ["👍"], onAddReaction });
        await open("text");
        await userEvent.click(await screen.findByText("Add reaction"));
        expect(onAddReaction).toHaveBeenCalledOnce();
    });

    it("has no reaction row where the reader may not post", async () => {
        menu({ onReact: () => {}, quick: ["👍"], canPost: false });
        await open("text");
        await screen.findByText("Copy text");
        expect(screen.queryAllByLabelText(/^React with/)).toHaveLength(0);
    });
});

describe("Remind me", () => {
    it("sets a reminder from a preset", async () => {
        menu();
        await open("text");
        await userEvent.click(await screen.findByText("Remind me"));
        await userEvent.click(await screen.findByText("In 1 hour"));
        expect(setReminderAction).toHaveBeenCalledOnce();
        const asked = setReminderAction.mock.calls[0]![0] as { dueAt: string; messageId?: string };
        const wait = new Date(asked.dueAt).getTime() - Date.now();
        expect(wait).toBeGreaterThan(59 * 60_000);
        expect(wait).toBeLessThanOrEqual(60 * 60_000);
    });

    it("is not offered on a deleted message", async () => {
        render(
            <ToastProvider>
                <MessageMenu
                    actions={{
                        message: { ...MESSAGE, deleted: true, attachments: [] },
                        mine: false,
                        canPost: true,
                        canModerate: false,
                        onStar: () => {},
                        onDelete: () => {},
                        onReport: () => {},
                        onExplain: () => {}
                    }}
                >
                    <div data-testid="row">gone</div>
                </MessageMenu>
            </ToastProvider>,
            { wrapper: MessagesWrapper }
        );
        await open("row");
        await screen.findByText("Copy message link");
        expect(screen.queryByText("Remind me")).toBeNull();
    });
});
