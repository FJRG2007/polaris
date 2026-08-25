// @vitest-environment jsdom

/**
 * Right-clicking a space in the column.
 *
 * The menu was written, wired and drawn into the tree, and nothing could open
 * it. The trigger passes its handlers and a ref to the tile with `asChild`, and
 * the tile was a plain function component: React hands a function component
 * props it does not declare and drops them without a word, so every space in the
 * column had a menu with no way in and nothing anywhere said so.
 *
 * That is why this is a test rather than a careful read of the component. The
 * failure is silent by construction - it typechecks, it renders, it looks
 * finished - so the only thing that catches it coming back is opening the menu.
 *
 * It also asserts what a plain member is offered, because the personal setting
 * in there is not an administrator's: how loudly a space may interrupt you is
 * yours whatever your seat in it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const space = {
    id: "space-1",
    name: "Engineering",
    description: "",
    color: "#7c5cff",
    visibility: "private" as const,
    orgId: null,
    orgName: null,
    archived: false,
    access: "member" as const,
    notifyLevel: "mentions" as const
};

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        spaces: [space],
        channels: [],
        activeSpaceId: null,
        setActiveSpaceId: () => undefined,
        refresh: () => undefined,
        may: { spaces: false }
    })
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    leaveSpaceAction: async () => ({}),
    setSpaceNotifyAction: async () => ({})
}));
// The dialogs the rail holds open. None of them is what this is about, and each
// pulls a good deal of the app in behind it.
vi.mock("@/app/(app)/chat/leave-dialog", () => ({ LeaveDialog: () => null }));
vi.mock("@/app/(app)/chat/bans-dialog", () => ({ BansDialog: () => null }));
vi.mock("@/app/(app)/chat/invite-dialog", () => ({ InviteDialog: () => null }));
vi.mock("@/app/(app)/chat/new-space-dialog", () => ({ NewSpaceDialog: () => null }));
vi.mock("@/app/(app)/chat/picture-dialog", () => ({ ChatPictureDialog: () => null }));
vi.mock("@/app/(app)/chat/new-channel-dialog", () => ({ NewChannelDialog: () => null }));

const { ServerRail } = await import("@/app/(app)/chat/server-rail");

afterEach(cleanup);

describe("the menu on a space", () => {
    it("opens on a right-click", () => {
        render(<ServerRail />);
        // The tile is the space's initials; its name is written out nowhere
        // until the menu that is headed by it opens.
        expect(screen.queryByText("Engineering")).toBeNull();

        fireEvent.contextMenu(screen.getByRole("button", { name: "Engineering" }));
        expect(screen.getByText("Engineering")).toBeTruthy();
    });

    it("offers the notification setting to somebody who only reads the space", () => {
        render(<ServerRail />);
        fireEvent.contextMenu(screen.getByRole("button", { name: "Engineering" }));

        // Not an administrator's: what a space is allowed to interrupt you with
        // is a fact about you, not about your seat in it.
        expect(screen.getByText("Notifications")).toBeTruthy();
        expect(screen.queryByText("New channel")).toBeNull();
    });
});
