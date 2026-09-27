// @vitest-environment jsdom

/**
 * Who an announcement goes to: everybody, the operators who are on, or players
 * picked out - one or several.
 *
 * What is pinned: a target saved before there was a choice reads as it did;
 * several players get the same lines each, and nobody else does; operators
 * become the names of the ones on, and none on refuses rather than reaching
 * everybody; nothing that is not a name is written into a command; and the
 * screen lets several players be ticked and sends to exactly them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
    BLANK_ANNOUNCEMENT,
    announcementCommands,
    announcementProblems,
    clearAnnouncementCommands,
    type Announcement
} from "@polaris-app/game-servers/src/lib/minecraft/announcement";
import {
    describeTarget,
    parseTarget,
    playersTarget
} from "@polaris-app/game-servers/src/lib/minecraft/announce-target";

const sent: { announcement: Announcement }[] = [];

// jsdom draws no layout, so it has no scrolling to do; the select asks anyway.
Element.prototype.scrollIntoView ??= () => undefined;

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        confirmDialog: { useConfirm: () => [async () => true, null] },
        copyButton: { CopyButton: () => null }
    }
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/announce-actions", () => ({
    listAnnouncementTemplatesAction: async () => ({ templates: [] }),
    sendAnnouncementAction: async (input: { announcement: Announcement }) => {
        sent.push(input);
        return { sent: 2 };
    },
    saveAnnouncementTemplateAction: async () => ({ templates: [] }),
    deleteAnnouncementTemplateAction: async () => ({ templates: [] })
}));

const { MinecraftAnnounce } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-announce"
);

afterEach(() => {
    cleanup();
    sent.length = 0;
});

const draft = (over: Partial<Announcement>): Announcement => ({ ...BLANK_ANNOUNCEMENT, ...over });
const NONE = { values: {}, recipients: null };

describe("what a target means", () => {
    it("reads the two older forms as they always did", () => {
        expect(parseTarget("@a")).toEqual({ kind: "everybody" });
        expect(parseTarget("Steve")).toEqual({ kind: "players", players: ["Steve"] });
    });

    it("reads operators and several players", () => {
        expect(parseTarget("@ops")).toEqual({ kind: "operators" });
        expect(parseTarget(playersTarget(["Steve", "Alex"]))).toEqual({
            kind: "players",
            players: ["Steve", "Alex"]
        });
    });

    it("refuses anything that is not a name, and a name twice", () => {
        expect(parseTarget("")).toBeNull();
        expect(parseTarget("@e")).toBeNull();
        expect(parseTarget("Steve,@a")).toBeNull();
        expect(parseTarget("Steve; op Mallory")).toBeNull();
        expect(parseTarget("Steve,steve")).toBeNull();
    });

    it("says who it went to", () => {
        expect(describeTarget("@a")).toBe("everybody on the server");
        expect(describeTarget("@ops")).toBe("the operators who are on");
        expect(describeTarget("Steve,Alex")).toBe("Steve and Alex");
        expect(describeTarget("A,B,C,D")).toBe("A, B and 2 more");
    });
});

describe("the lines it becomes", () => {
    it("sends the same to each player picked, and nobody else", () => {
        const lines = announcementCommands("java", draft({ target: "Steve,Alex", chat: "Hi", sound: "minecraft:entity.player.levelup" }), NONE);
        expect(lines.filter((line) => line.startsWith("tellraw Steve "))).toHaveLength(1);
        expect(lines.filter((line) => line.startsWith("tellraw Alex "))).toHaveLength(1);
        expect(lines.some((line) => line.includes("@a"))).toBe(false);
        expect(lines.filter((line) => line.includes("playsound"))).toHaveLength(2);
    });

    it("sends to the operators who are on, by name", () => {
        const lines = announcementCommands("java", draft({ target: "@ops", title: "Staff meeting" }), {
            ...NONE,
            operators: ["Admin1", "Admin2"]
        });
        expect(lines.some((line) => line.startsWith("title Admin1 title "))).toBe(true);
        expect(lines.some((line) => line.startsWith("title Admin2 title "))).toBe(true);
        expect(lines.some((line) => line.includes("@a"))).toBe(false);
    });

    it("refuses when no operator is on, rather than reaching everybody", () => {
        expect(() =>
            announcementCommands("java", draft({ target: "@ops", chat: "Hi" }), { ...NONE, operators: [] })
        ).toThrow("No operator is on the server right now");
    });

    it("takes a held one down from the same people", () => {
        expect(clearAnnouncementCommands("java", draft({ target: "Steve,Alex", title: "Hi" }))).toEqual([
            "title Steve clear",
            "title Alex clear"
        ]);
        expect(clearAnnouncementCommands("java", draft({ target: "@ops", title: "Hi" }), ["Admin1"])).toEqual([
            "title Admin1 clear"
        ]);
    });

    it("says so under Send to, and refuses operators on Bedrock", () => {
        expect(announcementProblems(draft({ target: "", chat: "Hi" }), "java").target).toBe("Choose who it goes to");
        expect(announcementProblems(draft({ target: "@ops", chat: "Hi" }), "bedrock").target).toMatch(/Bedrock/);
        expect(announcementProblems(draft({ target: "@ops", chat: "Hi" }), "java").target).toBeUndefined();
    });

    it("measures an operators one against the longest name an operator can have", () => {
        const longest = "A".repeat(16);
        let caught = false;
        for (let pad = 0; pad <= 360; pad++) {
            const chat = `${"&a&lx".repeat(30)}${"y".repeat(pad)}`;
            const ops = announcementProblems(draft({ target: "@ops", chat }), "java").chat;
            expect(ops).toBe(announcementProblems(draft({ target: longest, chat }), "java").chat);
            if (ops && !announcementProblems(draft({ target: "@a", chat }), "java").chat) caught = true;
        }
        expect(caught).toBe(true);
    });
});

describe("the Send to control", () => {
    it("ticks several players and sends to exactly them", async () => {
        render(<MinecraftAnnounce installedAppId="s1" running edition="java" players={["Steve", "Alex", "Zed"]} />);
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Hello" } });
        fireEvent.click(screen.getByRole("combobox", { name: "Send to" }));
        fireEvent.click(await screen.findByRole("option", { name: "Players I pick" }));
        fireEvent.click(await screen.findByRole("checkbox", { name: "Steve" }));
        fireEvent.click(screen.getByRole("checkbox", { name: "Zed" }));
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
        });
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]?.announcement.target).toBe("Steve,Zed");
        expect(await screen.findByText("Sent to Steve and Zed.")).toBeTruthy();
    });

    it("does not let a name that cannot be aimed at be ticked", async () => {
        render(<MinecraftAnnounce installedAppId="s1" running edition="bedrock" players={["Steve", "Big Bob"]} />);
        fireEvent.click(screen.getByRole("combobox", { name: "Send to" }));
        fireEvent.click(await screen.findByRole("option", { name: "Players I pick" }));
        expect((screen.getByRole("checkbox", { name: /Big Bob/ }) as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByRole("checkbox", { name: "Steve" }) as HTMLInputElement).disabled).toBe(false);
    });

    it("will not send to nobody", async () => {
        render(<MinecraftAnnounce installedAppId="s1" running edition="java" players={["Steve"]} />);
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Hello" } });
        fireEvent.click(screen.getByRole("combobox", { name: "Send to" }));
        fireEvent.click(await screen.findByRole("option", { name: "Players I pick" }));
        expect((screen.getByRole("button", { name: /^Send$/ }) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByRole("alert").textContent).toBe("Choose who it goes to");
    });
});
