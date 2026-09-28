// @vitest-environment jsdom

/**
 * The Linked chat screen, and the side panel pointing at it: the group a server
 * chose for `{call.*}` before the screen existed is shown as its link, a change
 * is what enables Save, and what is saved is the whole link.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_SIDEBAR } from "@polaris-app/game-servers/src/lib/minecraft/sidebar";

Element.prototype.scrollIntoView ??= () => undefined;

const GROUP = "01a09cdd-7a10-7811-833d-8b014c82de02";

const fake = vi.hoisted(() => ({
    saved: [] as unknown[],
    callLinked: true,
    groups: [] as { id: string; name: string }[]
}));

vi.mock("@polaris-app/game-servers/src/screens/installed/chat-link-actions", () => ({
    readChatLinkAction: async () => ({
        state: {
            // What a server set up before the link reads as: its old group.
            link: {
                kind: "group",
                groupId: "01a09cdd-7a10-7811-833d-8b014c82de02",
                commands: true,
                announcements: false,
                relay: false
            },
            linkable: { groups: fake.groups, spaces: [] },
            java: true
        }
    }),
    saveChatLinkAction: async (input: { link: unknown }) => {
        fake.saved.push(input);
        return { state: { link: input.link, linkable: { groups: [], spaces: [] }, java: true } };
    }
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/live-display-actions", () => ({
    readLiveDisplayAction: async () => ({
        state: {
            pinned: null,
            sidebar: { ...DEFAULT_SIDEBAR },
            sidebarRefusal: null,
            callLinked: fake.callLinked,
            known: {}
        }
    }),
    saveLiveDisplayAction: async () => ({})
}));
vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        liveRead: { useKeptSnapshot: () => undefined },
        snapshotCache: { readSnapshot: () => null, writeSnapshot: () => undefined, dropSnapshots: () => undefined },
        structuralMerge: { mergeUnchanged: <T,>(_previous: T, next: T) => next },
        confirmDialog: { useConfirm: () => [async () => true, null] },
        copyButton: { CopyButton: () => null }
    }
}));

const { MinecraftChatLink } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-chat-link"
);
const { MinecraftSidebar } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-sidebar"
);

beforeEach(() => {
    fake.saved = [];
    fake.callLinked = true;
    fake.groups = [{ id: GROUP, name: "Builders" }];
});
afterEach(cleanup);

describe("Linked chat", () => {
    it("shows the group chosen before, with nothing to save until something changes", async () => {
        render(<MinecraftChatLink installedAppId="s1" />);
        await screen.findByText("Builders");
        expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
        expect(screen.getByRole("switch", { name: "Answer commands" })).toHaveProperty(
            "ariaChecked",
            "true"
        );
        // The conversation is a way away.
        expect(screen.getByRole("link", { name: /Open in Chat/ }).getAttribute("href")).toBe(
            `/chat/c/${GROUP}`
        );
    });

    it("saves the whole link when what it is used for changes", async () => {
        render(<MinecraftChatLink installedAppId="s1" />);
        await screen.findByText("Builders");
        fireEvent.click(screen.getByRole("switch", { name: "Repeat announcements" }));
        const save = screen.getByRole("button", { name: "Save" });
        expect(save).toHaveProperty("disabled", false);
        fireEvent.click(save);
        await waitFor(() => expect(fake.saved).toHaveLength(1));
        expect(fake.saved[0]).toEqual({
            installedAppId: "s1",
            link: {
                kind: "group",
                groupId: GROUP,
                commands: true,
                announcements: true,
                relay: false
            }
        });
        await screen.findByText("Linked.");
    });

    it("lets a manager outside the group change its commands, but not show or write into it", async () => {
        fake.groups = [];
        render(<MinecraftChatLink installedAppId="s1" />);
        await screen.findByText("A group you are not in");
        const locked = (name: string) =>
            screen.getByRole("switch", { name }).hasAttribute("disabled");
        expect(locked("Answer commands")).toBe(false);
        expect(locked("Repeat announcements")).toBe(true);
        expect(locked("Show its messages in the game")).toBe(true);
    });
});

describe("the side panel", () => {
    it("no longer chooses the group, and points at Linked chat instead", async () => {
        render(<MinecraftSidebar installedAppId="s1" canManage />);
        const link = await screen.findByRole("link", { name: "Change it in Linked chat" });
        expect(link.getAttribute("href")).toBe("/apps/installed/s1/chat");
        expect(screen.queryByLabelText("Chat group whose call is shown")).toBeNull();
    });

    it("says a chat has to be linked when none is", async () => {
        fake.callLinked = false;
        render(<MinecraftSidebar installedAppId="s1" canManage />);
        expect(
            (await screen.findByRole("link", { name: "Link one in Linked chat" })).getAttribute(
                "href"
            )
        ).toBe("/apps/installed/s1/chat");
    });
});
