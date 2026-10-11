// @vitest-environment jsdom
/**
 * The member list beside a space's channel, as drawn.
 *
 * Two headings with counts, the people who are around under the first, the rest
 * under the second and faint - and only as many rows as fit, because a space can
 * hold thousands and the list must not draw them all.
 */

import { MessagesWrapper } from "../setup/i18n";
import { ChannelMembers } from "@/app/(app)/chat/members-panel";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    members: [] as { userId: string; name: string; role: string; online: boolean }[],
    asked: [] as string[],
    height: 600
}));

vi.mock("@/app/(app)/chat/actions", () => ({
    listRosterAction: async (channelId: string) => {
        state.asked.push(channelId);
        return { members: state.members };
    },
    openDirectAction: async () => ({ id: "d1" })
}));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/account/report-actions", () => ({ reportPersonAction: async () => ({}) }));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));
vi.mock("@/app/(app)/chat/use-wide-screen", () => ({
    WIDE_ENOUGH: "(min-width: 1024px)",
    useWideScreen: () => true
}));
vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        viewerId: "ada",
        blocked: new Set<string>(),
        friends: new Set<string>(),
        spaces: [],
        channels: [],
        refresh: () => undefined
    })
}));

const channel = (spaceId: string | null) =>
    ({
        id: "c1",
        name: "general",
        kind: spaceId ? "text" : "group",
        spaceId,
        categoryId: null,
        archived: false,
        ownerId: null,
        unreadCount: 0,
        mayModerate: false,
        others: [],
        gameLinks: []
    }) as never;

function panel(spaceId: string | null = "s1") {
    return render(
        <ChannelMembers
            channel={channel(spaceId)}
            open
            onOpenChange={() => undefined}
            onMention={() => undefined}
        />,
        { wrapper: MessagesWrapper }
    );
}

beforeEach(() => {
    state.asked = [];
    state.height = 600;
    state.members = [
        { userId: "ada", name: "Ada", role: "owner", online: true },
        { userId: "zoe", name: "Zoe", role: "member", online: false },
        { userId: "bob", name: "Bob", role: "admin", online: true },
        { userId: "cy", name: "Cy", role: "member", online: false }
    ];
    const kept = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => kept.get(key) ?? null,
            setItem: (key: string, value: string) => void kept.set(key, value),
            removeItem: (key: string) => void kept.delete(key),
            clear: () => kept.clear()
        }
    });
    // jsdom lays nothing out; the list needs a box with a height to know how
    // many rows fit in it.
    Element.prototype.getBoundingClientRect = function () {
        return {
            width: 240,
            height: state.height,
            top: 0,
            left: 0,
            right: 240,
            bottom: state.height,
            x: 0,
            y: 0,
            toJSON: () => ({})
        };
    };
});
afterEach(cleanup);

describe("a space's member list", () => {
    it("heads who is around and who is not, with how many of each", async () => {
        panel();
        expect(await screen.findByRole("heading", { name: "Online - 2" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Offline - 2" })).toBeTruthy();
        expect(state.asked).toEqual(["c1"]);
    });

    it("lists the people around first, by name, and the rest faint after them", async () => {
        panel();
        await screen.findByRole("heading", { name: "Online - 2" });
        const order = Array.from(document.querySelectorAll("aside li")).map((row) =>
            row.textContent?.replace(/\s+/g, " ").trim()
        );
        expect(order[0]).toBe("Online - 2");
        expect(order[1]).toContain("Ada");
        expect(order[2]).toContain("Bob");
        expect(order[3]).toBe("Offline - 2");
        expect(order[4]).toContain("Cy");
        expect(order[5]).toContain("Zoe");

        const faint = (name: string) =>
            screen.getByRole("button", { name: new RegExp(name) }).className.includes("opacity-50");
        expect(faint("Bob")).toBe(false);
        expect(faint("Zoe")).toBe(true);
    });

    it("draws only the rows that fit, however many people there are", async () => {
        state.height = 400;
        state.members = Array.from({ length: 3000 }, (_, index) => ({
            userId: `u${index}`,
            name: `Person ${String(index).padStart(4, "0")}`,
            role: "member",
            online: index % 3 === 0
        }));
        panel();
        expect(await screen.findByRole("heading", { name: "Online - 1000" })).toBeTruthy();
        const drawn = document.querySelectorAll("aside li").length;
        expect(drawn).toBeGreaterThan(5);
        expect(drawn).toBeLessThan(60);
    });

    it("keeps a group as one list, owner first, with no headings", async () => {
        panel(null);
        await screen.findByRole("button", { name: /Zoe/ });
        expect(screen.queryByRole("heading", { name: /Online|Offline/ })).toBeNull();
    });
});
