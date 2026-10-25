// @vitest-environment jsdom

/**
 * Deleting a message the way Discord does: asked with the message itself on
 * screen, and not asked at all with Shift held - from the menu, from the hover
 * row and from the delete key as the reader has it bound.
 *
 * Driven through the real list and the real hook, with only the server action
 * faked, so the tombstone, the rollback and the permission check are the ones
 * the conversation uses.
 */

import { useState } from "react";
import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import type { ChatMessageView } from "@/lib/chat/messages";
import { MessageList } from "@/app/(app)/chat/message-list";
import { ShortcutsProvider, ToastProvider } from "@polaris/ui";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteMessageDialog, useMessageDelete } from "@/app/(app)/chat/delete-message";

const deleteMessageAction = vi.fn(async (_id: string): Promise<{ error?: string }> => ({}));

vi.mock("@/app/(app)/chat/actions", () => ({
    deleteMessageAction: (id: string) => deleteMessageAction(id),
    saveMediaAction: async () => ({}),
    unsaveMediaAction: async () => ({}),
    linkPreviewAction: async () => ({}),
    openDirectAction: async () => ({ id: "d1" })
}));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    listBlockedAction: async () => ({ people: [] }),
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/account/report-actions", () => ({
    reportPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        blocked: new Set<string>(),
        friends: new Set<string>(),
        channels: [
            {
                id: "c1",
                spaceId: null,
                categoryId: null,
                kind: "group",
                name: "A room",
                archived: false,
                ownerId: null,
                others: []
            }
        ],
        spaces: [],
        may: {},
        refresh: () => undefined
    })
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
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

beforeEach(() => {
    deleteMessageAction.mockReset();
    deleteMessageAction.mockResolvedValue({});
});
afterEach(cleanup);

function message(id: string, authorId: string, body = `message ${id}`): ChatMessageView {
    return {
        id,
        channelId: "c1",
        authorId,
        authorName: authorId,
        kind: "text",
        body,
        parentId: null,
        replyCount: 0,
        lastReplyAt: null,
        edited: false,
        deleted: false,
        reactions: [],
        attachments: [],
        quote: null,
        starred: false,
        references: [],
        forwardable: true,
        link: null,
        preview: null,
        previewPending: false,
        receipt: null,
        createdAt: new Date(1_700_000_000_000).toISOString()
    } as unknown as ChatMessageView;
}

function Conversation({
    initial,
    viewerId = "ada",
    canModerate = false
}: {
    initial: ChatMessageView[];
    viewerId?: string;
    canModerate?: boolean;
}) {
    const [messages, setMessages] = useState<readonly ChatMessageView[] | null>(initial);
    const [error, setError] = useState("");
    const { request, dialog } = useMessageDelete({ setMessages, setError, leavesTrace: false });
    return (
        <>
            <MessageList
                messages={messages ?? []}
                viewerId={viewerId}
                canPost
                canModerate={canModerate}
                onReact={() => undefined}
                onStar={() => undefined}
                onForward={() => undefined}
                onEdit={() => undefined}
                onDelete={request}
            />
            {dialog}
            <p data-testid="error">{error}</p>
        </>
    );
}

function draw(element: React.ReactElement, overrides: Record<string, string[]> = {}) {
    return render(
        <ShortcutsProvider overrides={overrides}>
            <ToastProvider>{element}</ToastProvider>
        </ShortcutsProvider>,
        { wrapper: MessagesWrapper }
    );
}

async function openMenu(id: string) {
    // Inside the menu's trigger: the body text, as somebody right-clicks it.
    const row = within(document.getElementById(`message-${id}`)!).getByText(/^message /);
    await userEvent.pointer({ keys: "[MouseRight]", target: row });
    return screen.findByRole("menuitem", { name: /^Delete/ });
}

describe("Shift skips the question", () => {
    it("from the delete key, with no dialog", async () => {
        const user = userEvent.setup();
        draw(<Conversation initial={[message("m1", "ada")]} />);
        await user.tab();
        await user.keyboard("{Shift>}{Delete}{/Shift}");

        expect(deleteMessageAction).toHaveBeenCalledWith("m1");
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(await screen.findByText("This message was deleted.")).toBeTruthy();
    });

    it("from the key as rebound, not a hardcoded Delete", async () => {
        const user = userEvent.setup();
        draw(<Conversation initial={[message("m1", "ada")]} />, { "chat.delete": ["x"] });
        await user.tab();
        await user.keyboard("{Shift>}{Delete}{/Shift}");
        expect(deleteMessageAction).not.toHaveBeenCalled();

        await user.keyboard("{Shift>}x{/Shift}");
        expect(deleteMessageAction).toHaveBeenCalledWith("m1");
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("from the context menu, with no dialog", async () => {
        const user = userEvent.setup();
        draw(<Conversation initial={[message("m1", "ada")]} />);
        const item = await openMenu("m1");
        await user.keyboard("{Shift>}");
        await user.click(item);
        await user.keyboard("{/Shift}");

        expect(deleteMessageAction).toHaveBeenCalledWith("m1");
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("puts the message back with the reason when the server refuses", async () => {
        deleteMessageAction.mockResolvedValue({ error: "Not allowed here." });
        const user = userEvent.setup();
        draw(<Conversation initial={[message("m1", "ada", "keep me")]} />);
        await user.tab();
        await user.keyboard("{Shift>}{Delete}{/Shift}");

        await waitFor(() =>
            expect(screen.getByTestId("error").textContent).toBe("Not allowed here.")
        );
        expect(screen.getByText("keep me")).toBeTruthy();
        expect(screen.queryByText("This message was deleted.")).toBeNull();
    });
});

describe("without Shift", () => {
    it("the key opens the dialog with the message in it", async () => {
        const user = userEvent.setup();
        draw(<Conversation initial={[message("m1", "ada", "the **plan** for friday")]} />);
        await user.tab();
        await user.keyboard("{Delete}");

        const dialog = await screen.findByRole("dialog");
        expect(deleteMessageAction).not.toHaveBeenCalled();
        expect(within(dialog).getByText("Are you sure you want to delete this message?")).toBeTruthy();
        const preview = within(dialog).getByTestId("delete-preview");
        expect(within(preview).getByText("ada")).toBeTruthy();
        // Rendered, not the stored markup.
        expect(within(preview).getByText("plan").tagName).toBe("STRONG");

        await user.click(within(dialog).getByRole("button", { name: "Delete" }));
        expect(deleteMessageAction).toHaveBeenCalledWith("m1");
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("a plain click in the menu opens the dialog", async () => {
        const user = userEvent.setup();
        draw(<Conversation initial={[message("m1", "ada")]} />);
        await user.click(await openMenu("m1"));

        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByTestId("delete-preview").textContent).toContain("message m1");
        expect(deleteMessageAction).not.toHaveBeenCalled();
    });
});

describe("the protip", () => {
    function dialog(overrides: Record<string, string[]> = {}) {
        draw(
            <DeleteMessageDialog
                message={message("m1", "ada")}
                leavesTrace={false}
                onOpenChange={() => undefined}
                onConfirm={() => undefined}
            />,
            overrides
        );
        return screen.getByTestId("delete-protip");
    }

    it("names Shift and the delete key as bound", async () => {
        const tip = dialog({ "chat.delete": ["x"] });
        await waitFor(() => expect(tip.textContent).toContain("Shift+X"));
        expect(tip.textContent).toContain("Protip:");
    });

    it("follows the default key", () => {
        const tip = dialog();
        expect(tip.textContent).toMatch(/Shift\+Del/);
    });

    it("leaves the key out when the binding already needs Shift", async () => {
        const tip = dialog({ "chat.delete": ["Shift+x"] });
        await waitFor(() => expect(tip.textContent).not.toContain("press"));
        expect(tip.textContent).toContain("Shift");
    });
});

describe("permissions are unchanged", () => {
    it("somebody else's message is not taken down by a reader", async () => {
        const user = userEvent.setup();
        draw(<Conversation initial={[message("m1", "grace")]} />);
        await user.tab();
        await user.keyboard("{Shift>}{Delete}{/Shift}");
        await user.keyboard("{Delete}");
        expect(deleteMessageAction).not.toHaveBeenCalled();
        expect(screen.queryByRole("dialog")).toBeNull();

        await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("message m1") });
        await screen.findAllByRole("menuitem");
        expect(screen.queryByRole("menuitem", { name: /^Delete/ })).toBeNull();
    });

    it("a moderator may", async () => {
        const user = userEvent.setup();
        draw(<Conversation initial={[message("m1", "grace")]} canModerate />);
        await user.tab();
        await user.keyboard("{Shift>}{Delete}{/Shift}");
        expect(deleteMessageAction).toHaveBeenCalledWith("m1");
    });
});
