// @vitest-environment jsdom

/**
 * The rail while its first read has not landed, as a reader sees it: a skeleton
 * while waiting, a way to try again once it failed, and the tab's kept list
 * under that notice rather than instead of it.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
    useParams: () => ({}),
    usePathname: () => "/chat",
    useRouter: () => ({ push: () => undefined })
}));
vi.mock("@/lib/session", () => ({}));
vi.mock("@/lib/auth", () => ({}));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    voicePresenceAction: async () => ({ inRoom: {} }),
    searchPeopleAction: async () => ({ people: [] })
}));

const refresh = vi.fn();
let chatState: Record<string, unknown> = {};

vi.mock("@/app/(app)/chat/chat-context", () => ({ useChat: () => chatState }));

const { ChatSidebar } = await import("@/app/(app)/chat/chat-sidebar");

const failure = /could not be loaded/;
const list = "Nobody yet.";

beforeEach(() => {
    refresh.mockClear();
    chatState = {
        viewerId: "ada",
        may: { spaces: true, groups: true, attach: true, call: false, meetings: false },
        channels: [],
        spaces: [],
        categories: [],
        activeSpaceId: null,
        setActiveSpaceId: () => undefined,
        refresh,
        loaded: false,
        kept: false,
        loadFailed: false,
        blocked: new Set<string>(),
        friends: new Set<string>()
    };
});

afterEach(cleanup);

describe("the rail before its first answer", () => {
    it("says nothing has failed while it is still waiting", () => {
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.queryByText(list)).toBeNull();
    });

    it("says so when the read failed and tries again on demand", () => {
        chatState = { ...chatState, loadFailed: true };
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("alert").textContent).toMatch(failure);
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(refresh).toHaveBeenCalledOnce();
        expect(screen.queryByText(list)).toBeNull();
    });

    it("keeps drawing the kept list under the notice", () => {
        chatState = { ...chatState, kept: true, loadFailed: true };
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("alert").textContent).toMatch(failure);
        expect(screen.getByText(list)).toBeTruthy();
    });

    it("draws the kept list with no notice while the read is on its way", () => {
        chatState = { ...chatState, kept: true };
        render(<ChatSidebar />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByText(list)).toBeTruthy();
    });
});
