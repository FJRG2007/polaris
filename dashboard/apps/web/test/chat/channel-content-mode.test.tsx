// @vitest-environment jsdom

/**
 * What a channel's content setting and its webhooks change about the messages
 * in it, as a reader sees them.
 *
 * - A channel set to "All spoilers" covers every picture and link card, the
 *   way a sender's own spoiler mark covers one; an ordinary channel does not.
 * - A message posted through a webhook carries the name it was posted under and
 *   an APP tag, because no person wrote it.
 * - An age-restricted channel's gate asks, and answering it is what opens it.
 */

import { MessagesWrapper } from "../setup/i18n";
import { MessageList } from "@/app/(app)/chat/message-list";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const confirmed: string[] = [];
const pushed: string[] = [];

vi.mock("@/app/(app)/chat/actions", () => ({
    saveMediaAction: async () => ({}),
    unsaveMediaAction: async () => ({}),
    linkPreviewAction: async () => ({}),
    openDirectAction: async () => ({ id: "d1" }),
    confirmAgeAction: async (channelId: string) => {
        confirmed.push(channelId);
        return {};
    }
}));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    listBlockedAction: async () => ({ people: [] }),
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/account/report-actions", () => ({ reportPersonAction: async () => ({}) }));
vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        blocked: new Set<string>(),
        friends: new Set<string>(),
        refresh: () => undefined,
        channels: [],
        spaces: []
    })
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: (to: string) => pushed.push(to), refresh: () => undefined })
}));

const { AgeGate } = await import("@/app/(app)/chat/age-gate");

function message(overrides: Record<string, unknown> = {}) {
    return {
        id: "m1",
        channelId: "c1",
        authorId: "grace",
        authorName: "grace",
        kind: "text" as const,
        body: "a picture",
        parentId: null,
        replyCount: 0,
        lastReplyAt: null,
        edited: false,
        deleted: false,
        reactions: [],
        attachments: [
            {
                id: "f1",
                name: "photo.png",
                size: 10,
                contentType: "image/png",
                inline: true,
                durationMs: null,
                waveform: null,
                hasPoster: false,
                spoiler: false,
                borrowed: false
            }
        ],
        poll: null,
        quote: null,
        starred: false,
        blocked: false,
        mentionsYou: false,
        references: [],
        forwardable: true,
        link: null,
        preview: null,
        previewPending: false,
        receipt: null,
        createdAt: new Date(1_700_000_000_000).toISOString(),
        ...overrides
    };
}

function list(messages: ReturnType<typeof message>[], coverMedia = false) {
    return render(
        <MessageList
            messages={messages}
            viewerId="ada"
            canPost
            canModerate={false}
            coverMedia={coverMedia}
            onReact={() => undefined}
            onStar={() => undefined}
            onDelete={() => undefined}
        />,
        { wrapper: MessagesWrapper }
    );
}

afterEach(cleanup);

describe("a channel of spoilers", () => {
    it("covers every picture until it is pressed", () => {
        list([message()], true);
        const cover = screen.getByRole("button", { name: "Show this picture" });
        fireEvent.click(cover);
        expect(screen.queryByRole("button", { name: "Show this picture" })).toBeNull();
    });

    it("covers nothing in an ordinary channel", () => {
        list([message()]);
        expect(screen.queryByRole("button", { name: "Show this picture" })).toBeNull();
    });
});

describe("a webhook's message", () => {
    it("carries the name it was posted under and an APP tag, and no face to press", () => {
        list([
            message({
                authorId: null,
                authorName: "Deploy bot",
                fromWebhook: true,
                attachments: [],
                body: "Deployed"
            })
        ]);
        expect(screen.getByText("Deploy bot")).toBeTruthy();
        expect(screen.getByText("APP")).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Deploy bot/ })).toBeNull();
    });

    it("is not tagged when a person wrote it", () => {
        list([message({ attachments: [] })]);
        expect(screen.queryByText("APP")).toBeNull();
    });
});

describe("the age gate", () => {
    it("asks, and confirming is what lets the reader in", async () => {
        const onConfirmed = vi.fn();
        render(<AgeGate channelId="c9" channelName="after-dark" onConfirmed={onConfirmed} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText("Age-restricted channel")).toBeTruthy();
        expect(screen.getByText(/#after-dark is marked as holding adult content/)).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));
        await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
        expect(confirmed).toEqual(["c9"]);
    });

    it("goes back without saying anything", () => {
        render(<AgeGate channelId="c9" channelName="after-dark" onConfirmed={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        fireEvent.click(screen.getByRole("button", { name: "Go back" }));
        expect(pushed).toEqual(["/chat"]);
        expect(confirmed).toEqual(["c9"]);
    });
});
