// @vitest-environment jsdom

/** The Create Channel dialog: a type is a card, and the card decides what is sent. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewChannelDialog } from "@/app/(app)/chat/new-channel-dialog";
import type { ChatSpaceView } from "@/lib/chat/chat-service";
import { MessagesWrapper } from "../setup/i18n";

const create = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());

vi.mock("@/app/(app)/chat/actions", () => ({ createChannelAction: create }));
vi.mock("@/app/(app)/chat/chat-context", () => ({ useChat: () => ({ refresh: () => undefined }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/new-build", () => ({ checkForNewBuild: async () => undefined }));
vi.mock("@/app/(app)/chat/chat-people-picker", () => ({
    ChatPeoplePicker: ({ label, onChange }: { label: string; onChange: (picked: { id: string; name: string }[]) => void }) => (
        <button type="button" onClick={() => onChange([{ id: "user-1", name: "Ana" }])}>
            {label}
        </button>
    )
}));

afterEach(() => {
    cleanup();
    create.mockReset();
    push.mockReset();
});

const space = { id: "space-1", name: "Crew" } as ChatSpaceView;

function open() {
    render(<NewChannelDialog space={space} onOpenChange={() => undefined} />, { wrapper: MessagesWrapper });
}

describe("creating a channel", () => {
    it("offers each type as a card, text chosen", () => {
        open();
        const cards = screen.getAllByRole("radio");
        expect(cards.map((card) => card.textContent)).toEqual([
            expect.stringContaining("Text"),
            expect.stringContaining("Voice"),
            expect.stringContaining("Stage"),
            expect.stringContaining("Announcement"),
            expect.stringContaining("Forum"),
            expect.stringContaining("Media")
        ]);
        expect(cards[0]?.getAttribute("aria-checked")).toBe("true");
    });

    it("sends an announcement channel as a text channel only administrators post in", async () => {
        create.mockResolvedValue({ id: "channel-new" });
        open();
        fireEvent.click(screen.getByRole("radio", { name: /Announcement/ }));
        fireEvent.change(screen.getByRole("textbox", { name: "Channel name" }), {
            target: { value: "News" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        expect(create.mock.calls[0]?.[0]).toMatchObject({
            spaceId: "space-1",
            kind: "text",
            announcement: true,
            private: false
        });
        await waitFor(() => expect(push).toHaveBeenCalledWith("/chat/c/channel-new"));
    });

    it("sends a private voice channel with the voice label on the button", async () => {
        create.mockResolvedValue({ id: "channel-voice" });
        open();
        fireEvent.click(screen.getByRole("radio", { name: /Voice/ }));
        fireEvent.click(screen.getByRole("switch"));
        fireEvent.change(screen.getByRole("textbox", { name: "Channel name" }), {
            target: { value: "lounge" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Create voice channel" }));
        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        expect(create.mock.calls[0]?.[0]).toMatchObject({ kind: "voice", announcement: false, private: true });
    });

    it("sends a stage as a voice channel with the stage flag", async () => {
        create.mockResolvedValue({ id: "channel-stage" });
        open();
        fireEvent.click(screen.getByRole("radio", { name: /Stage/ }));
        fireEvent.change(screen.getByRole("textbox", { name: "Channel name" }), {
            target: { value: "town-hall" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Create voice channel" }));
        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        expect(create.mock.calls[0]?.[0]).toMatchObject({ kind: "voice", stage: true, announcement: false });
    });

    it("puts the people picked in a private channel as it is made", async () => {
        create.mockResolvedValue({ id: "channel-private" });
        open();
        expect(screen.queryByRole("button", { name: "People in it" })).toBeNull();
        fireEvent.click(screen.getByRole("switch"));
        fireEvent.click(screen.getByRole("button", { name: "People in it" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Channel name" }), {
            target: { value: "crew" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        expect(create.mock.calls[0]?.[0]).toMatchObject({ private: true, memberIds: ["user-1"] });
        await waitFor(() => expect(push).toHaveBeenCalledWith("/chat/c/channel-private"));
    });

    it("sends a forum as its own kind", async () => {
        create.mockResolvedValue({ id: "channel-forum" });
        open();
        fireEvent.click(screen.getByRole("radio", { name: /Forum/ }));
        fireEvent.change(screen.getByRole("textbox", { name: "Channel name" }), {
            target: { value: "help" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        expect(create.mock.calls[0]?.[0]).toMatchObject({ kind: "forum", announcement: false });
    });
});
