// @vitest-environment jsdom

/** A forum channel's view: its posts as a list, filtered by tag, opened into the thread. */

import { MessagesWrapper } from "../setup/i18n";
import { ForumView } from "@/app/(app)/chat/forum-view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const list = vi.hoisted(() => vi.fn());
const read = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());

vi.mock("@/app/(app)/chat/forum-actions", () => ({
    listForumPostsAction: list,
    readForumAction: read,
    updateForumPostAction: update
}));
vi.mock("@/app/(app)/chat/chat-context", () => ({ useChat: () => ({ viewerId: "user-ada" }) }));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));

afterEach(() => {
    cleanup();
    list.mockReset();
    read.mockReset();
    update.mockReset();
});

const root = {
    id: "message-1",
    attachments: [
        {
            id: "file-1",
            name: "crash.png",
            size: 10,
            contentType: "image/png",
            inline: true,
            durationMs: null,
            waveform: null,
            hasPoster: false
        }
    ],
    authorName: "Ada",
    body: "The app crashes on start",
    replyCount: 2
};

function setUp(channelId: string, requireTag = false, media = false) {
    read.mockResolvedValue({
        forum: {
            guidelines: "Search first",
            requireTag,
            tags: [{ id: "tag-bug", name: "Bug" }],
            mayManage: false
        }
    });
    list.mockResolvedValue({
        page: {
            posts: [
                {
                    id: "post-1",
                    title: "Crash on start",
                    tagIds: ["tag-bug"],
                    createdAt: new Date(0).toISOString(),
                    lastActivityAt: new Date(0).toISOString(),
                    root
                }
            ],
            after: null
        }
    });
    const onOpenPost = vi.fn();
    render(<ForumView channelId={channelId} media={media} canPost onOpenPost={onOpenPost} />, {
        wrapper: MessagesWrapper
    });
    return onOpenPost;
}

describe("a forum's list", () => {
    it("shows the guidelines and each post with its tags and replies", async () => {
        setUp("forum-a");
        expect(await screen.findByText("Crash on start")).toBeTruthy();
        expect(screen.getByText("Search first")).toBeTruthy();
        expect(screen.getByText("2 replies")).toBeTruthy();
        expect(screen.getAllByText("Bug").length).toBeGreaterThan(0);
    });

    it("opens a post's thread from its row", async () => {
        const onOpenPost = setUp("forum-b");
        fireEvent.click(await screen.findByText("Crash on start"));
        expect(onOpenPost).toHaveBeenCalledWith(root);
    });

    it("asks the server again for one tag", async () => {
        setUp("forum-c");
        await screen.findByText("Crash on start");
        fireEvent.click(screen.getByRole("button", { name: "Bug", pressed: false }));
        await waitFor(() =>
            expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ tagId: "tag-bug" }))
        );
    });

    it("keeps Publish off until a required tag is picked", async () => {
        setUp("forum-d", true);
        await screen.findByText("Crash on start");
        fireEvent.click(screen.getByRole("button", { name: "New post" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Title *" }), { target: { value: "Help" } });
        fireEvent.change(screen.getByRole("textbox", { name: "Message *" }), { target: { value: "Hi" } });
        const post = screen.getByRole("button", { name: "Publish" });
        expect(post.hasAttribute("disabled")).toBe(true);
        const dialogTags = screen.getAllByRole("button", { name: "Bug" });
        fireEvent.click(dialogTags[dialogTags.length - 1]!);
        expect(post.hasAttribute("disabled")).toBe(false);
    });

    it("draws a media channel as a gallery of each post's first picture", async () => {
        setUp("media-a", false, true);
        const title = await screen.findByText("Crash on start");
        const tile = title.closest("button")!;
        expect(tile.querySelector("img")?.getAttribute("src")).toBe("/api/chat/attachments/file-1");
    });

    it("keeps Publish off in a media channel until a picture or video is picked", async () => {
        setUp("media-b", false, true);
        await screen.findByText("Crash on start");
        fireEvent.click(screen.getByRole("button", { name: "New post" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Title *" }), { target: { value: "Sunset" } });
        const post = screen.getByRole("button", { name: "Publish" });
        expect(post.hasAttribute("disabled")).toBe(true);
        const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
        fireEvent.change(input, { target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] } });
        expect(post.hasAttribute("disabled")).toBe(true);
        fireEvent.change(input, { target: { files: [new File(["x"], "sunset.jpg", { type: "image/jpeg" })] } });
        expect(screen.getByText("sunset.jpg")).toBeTruthy();
        expect(post.hasAttribute("disabled")).toBe(false);
    });
});

describe("editing a post after it was made", () => {
    function setUpOwn(channelId: string, authorId: string) {
        read.mockResolvedValue({
            forum: {
                guidelines: "",
                requireTag: false,
                tags: [
                    { id: "0190a0a0-0000-7000-8000-0000000000d1", name: "Bug" },
                    { id: "0190a0a0-0000-7000-8000-0000000000d2", name: "Idea" }
                ],
                mayManage: false
            }
        });
        list.mockResolvedValue({
            page: {
                posts: [
                    {
                        id: "0190a0a0-0000-7000-8000-0000000000cc",
                        title: "Crash on start",
                        tagIds: ["0190a0a0-0000-7000-8000-0000000000d1"],
                        createdAt: new Date(0).toISOString(),
                        lastActivityAt: new Date(0).toISOString(),
                        root: { ...root, authorId }
                    }
                ],
                after: null
            }
        });
        render(<ForumView channelId={channelId} canPost onOpenPost={vi.fn()} />, { wrapper: MessagesWrapper });
    }

    it("is not offered on somebody else's post", async () => {
        setUpOwn("forum-edit-a", "user-grace");
        expect(await screen.findByText("Crash on start")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Edit post" })).toBeNull();
    });

    it("shows the new title and tags at once and sends them", async () => {
        update.mockResolvedValue({});
        setUpOwn("forum-edit-b", "user-ada");
        fireEvent.click(await screen.findByRole("button", { name: "Edit post" }));
        const save = screen.getByRole("button", { name: "Save" });
        expect(save.getAttribute("aria-disabled")).toBe("true");
        fireEvent.change(screen.getByDisplayValue("Crash on start"), { target: { value: "Crash on launch" } });
        fireEvent.click(screen.getByRole("button", { name: "Idea" }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Crash on launch")).toBeTruthy();
        expect(update).toHaveBeenCalledWith({
            postId: "0190a0a0-0000-7000-8000-0000000000cc",
            title: "Crash on launch",
            tagIds: ["0190a0a0-0000-7000-8000-0000000000d1", "0190a0a0-0000-7000-8000-0000000000d2"]
        });
    });

    it("puts the old title back when the server refuses it", async () => {
        update.mockResolvedValue({ error: "That post is not yours" });
        setUpOwn("forum-edit-c", "user-ada");
        fireEvent.click(await screen.findByRole("button", { name: "Edit post" }));
        fireEvent.change(screen.getByDisplayValue("Crash on start"), { target: { value: "Renamed" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
        expect(await screen.findByText("Crash on start")).toBeTruthy();
        expect(screen.queryByText("Renamed")).toBeNull();
    });
});
