// @vitest-environment jsdom

/**
 * Who an announcement goes to: everybody, the operators who are on, everybody
 * but them, the players in one game mode, or players picked out - one or several.
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
    audienceNames,
    describeTarget,
    parseTarget,
    playersTarget
} from "@polaris-app/game-servers/src/lib/minecraft/announce-target";

const sent: { announcement: Announcement }[] = [];

// jsdom draws no layout, so it has no scrolling to do; the select asks anyway.
Element.prototype.scrollIntoView ??= () => undefined;

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        liveRead: { useKeptSnapshot: () => undefined },
        snapshotCache: { readSnapshot: () => null, writeSnapshot: () => undefined, dropSnapshots: () => undefined },
        structuralMerge: { mergeUnchanged: <T,>(_previous: T, next: T) => next },
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
        const lines = announcementCommands(
            "java",
            draft({ target: "Steve,Alex", chat: "Hi", sound: "minecraft:entity.player.levelup" }),
            NONE
        );
        expect(lines.filter((line) => line.startsWith("tellraw Steve "))).toHaveLength(1);
        expect(lines.filter((line) => line.startsWith("tellraw Alex "))).toHaveLength(1);
        expect(lines.some((line) => line.includes("@a"))).toBe(false);
        expect(lines.filter((line) => line.includes("playsound"))).toHaveLength(2);
    });

    it("sends to the operators who are on, by name", () => {
        const lines = announcementCommands(
            "java",
            draft({ target: "@ops", title: "Staff meeting" }),
            {
                ...NONE,
                named: ["Admin1", "Admin2"]
            }
        );
        expect(lines.some((line) => line.startsWith("title Admin1 title "))).toBe(true);
        expect(lines.some((line) => line.startsWith("title Admin2 title "))).toBe(true);
        expect(lines.some((line) => line.includes("@a"))).toBe(false);
    });

    it("refuses when no operator is on, rather than reaching everybody", () => {
        expect(() =>
            announcementCommands("java", draft({ target: "@ops", chat: "Hi" }), {
                ...NONE,
                named: []
            })
        ).toThrow("No operator is on the server right now");
    });

    it("takes a held one down from the same people", () => {
        expect(
            clearAnnouncementCommands("java", draft({ target: "Steve,Alex", title: "Hi" }))
        ).toEqual(["title Steve clear", "title Alex clear"]);
        expect(
            clearAnnouncementCommands("java", draft({ target: "@ops", title: "Hi" }), ["Admin1"])
        ).toEqual(["title Admin1 clear"]);
    });

    it("sends to everybody but the operators, by name, and refuses when only operators are on", () => {
        const roster = { players: ["Admin1", "Steve", "alex"], operators: ["admin1", "Ghost"] };
        const others = audienceNames({ kind: "others" }, roster);
        expect(others).toEqual(["Steve", "alex"]);
        expect(audienceNames({ kind: "operators" }, roster)).toEqual(["Admin1"]);
        const lines = announcementCommands("java", draft({ target: "@others", chat: "Hi" }), {
            ...NONE,
            named: others
        });
        expect(lines.map((line) => line.split(" ")[1])).toEqual(["Steve", "alex"]);
        expect(() =>
            announcementCommands("java", draft({ target: "@others", chat: "Hi" }), {
                ...NONE,
                named: []
            })
        ).toThrow("Nobody but operators is on the server right now");
        expect(describeTarget("@others")).toBe("everybody on the server but the operators");
        expect(
            clearAnnouncementCommands("java", draft({ target: "@others", title: "Hi" }), ["Steve"])
        ).toEqual(["title Steve clear"]);
    });

    it("sends to the players in one game mode with the game's own selector", () => {
        expect(parseTarget("@a[gamemode=creative]")).toEqual({
            kind: "gamemode",
            mode: "creative"
        });
        expect(parseTarget("@a[gamemode=hardcore]")).toBeNull();
        expect(describeTarget("@a[gamemode=survival]")).toBe("the players in Survival");
        const java = announcementCommands(
            "java",
            draft({ target: "@a[gamemode=survival]", title: "Hi", chat: "Hi" }),
            NONE
        );
        expect(java.some((line) => line.startsWith("title @a[gamemode=survival] title "))).toBe(
            true
        );
        expect(java.some((line) => line.startsWith("tellraw @a[gamemode=survival] "))).toBe(true);
        expect(java.some((line) => / @a /.test(line))).toBe(false);
        const bedrock = announcementCommands(
            "bedrock",
            draft({ target: "@a[gamemode=survival]", title: "Hi" }),
            NONE
        );
        expect(bedrock.some((line) => line.startsWith("titleraw @a[m=survival] title "))).toBe(
            true
        );
    });

    it("keeps a game mode around each player a line written for their account goes to", () => {
        const lines = announcementCommands(
            "java",
            draft({ target: "@a[gamemode=adventure]", chat: "Hi {polaris.name}" }),
            {
                values: {},
                recipients: [
                    { name: "Steve", values: { "polaris.name": "Steve B" } },
                    { name: "Alex", values: { "polaris.name": "Alex C" } }
                ]
            }
        );
        const chat = lines.filter((line) => line.includes("tellraw"));
        expect(chat).toHaveLength(2);
        expect(chat[0]).toMatch(/^execute as @a\[gamemode=adventure,name=Steve\] run tellraw @s /);
        expect(chat[1]).toMatch(/^execute as @a\[gamemode=adventure,name=Alex\] run tellraw @s /);
    });

    it("reaches a Bedrock gamertag with a space in a game mode", () => {
        const lines = announcementCommands(
            "bedrock",
            draft({ target: "@a[gamemode=survival]", chat: "Hi {polaris.name}" }),
            {
                values: {},
                recipients: [{ name: "Foo Bar", values: { "polaris.name": "Foo" } }]
            }
        );
        const chat = lines.filter((line) => line.includes("tellraw"));
        expect(chat).toHaveLength(1);
        expect(chat[0]).toMatch(/^execute as @a\[m=survival,name="Foo Bar"\] run tellraw @s /);
    });

    it("says so under Send to, and refuses operators on Bedrock", () => {
        expect(announcementProblems(draft({ target: "", chat: "Hi" }), "java").target).toBe(
            "Choose who it goes to"
        );
        expect(
            announcementProblems(draft({ target: "@ops", chat: "Hi" }), "bedrock").target
        ).toMatch(/Bedrock/);
        expect(
            announcementProblems(draft({ target: "@ops", chat: "Hi" }), "java").target
        ).toBeUndefined();
        expect(
            announcementProblems(draft({ target: "@others", chat: "Hi" }), "bedrock").target
        ).toMatch(/Bedrock/);
        expect(
            announcementProblems(draft({ target: "@a[gamemode=creative]", chat: "Hi" }), "bedrock")
                .target
        ).toBeUndefined();
    });

    it("measures an operators one against the longest name an operator can have", () => {
        const longest = "A".repeat(16);
        let caught = false;
        for (let pad = 0; pad <= 360; pad++) {
            const chat = `${"&a&lx".repeat(20)}${"y".repeat(pad)}`;
            const ops = announcementProblems(draft({ target: "@ops", chat }), "java").chat;
            expect(ops).toBe(announcementProblems(draft({ target: longest, chat }), "java").chat);
            if (ops && !announcementProblems(draft({ target: "@a", chat }), "java").chat)
                caught = true;
        }
        expect(caught).toBe(true);
    });
});

describe("the Send to control", () => {
    it("ticks several players and sends to exactly them", async () => {
        render(
            <MinecraftAnnounce
                installedAppId="s1"
                running
                edition="java"
                players={["Steve", "Alex", "Zed"]}
            />
        );
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
        render(
            <MinecraftAnnounce
                installedAppId="s1"
                running
                edition="bedrock"
                players={["Steve", "Big Bob"]}
            />
        );
        fireEvent.click(screen.getByRole("combobox", { name: "Send to" }));
        fireEvent.click(await screen.findByRole("option", { name: "Players I pick" }));
        expect(
            (screen.getByRole("checkbox", { name: /Big Bob/ }) as HTMLInputElement).disabled
        ).toBe(true);
        expect((screen.getByRole("checkbox", { name: "Steve" }) as HTMLInputElement).disabled).toBe(
            false
        );
    });

    it("offers everybody but operators and each game mode, and sends to what was chosen", async () => {
        render(
            <MinecraftAnnounce installedAppId="s1" running edition="java" players={["Steve"]} />
        );
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Hello" } });
        fireEvent.click(screen.getByRole("combobox", { name: "Send to" }));
        for (const label of [
            "Operators who are on",
            "Everybody but operators",
            "Players in Survival",
            "Players in Creative",
            "Players in Adventure",
            "Players in Spectator"
        ]) {
            expect(await screen.findByRole("option", { name: label })).toBeTruthy();
        }
        fireEvent.click(screen.getByRole("option", { name: "Players in Creative" }));
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
        });
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]?.announcement.target).toBe("@a[gamemode=creative]");
        expect(await screen.findByText("Sent to the players in Creative.")).toBeTruthy();
    });

    it("offers no operators choices on Bedrock", async () => {
        render(
            <MinecraftAnnounce installedAppId="s1" running edition="bedrock" players={["Steve"]} />
        );
        fireEvent.click(screen.getByRole("combobox", { name: "Send to" }));
        expect(await screen.findByRole("option", { name: "Players in Survival" })).toBeTruthy();
        expect(screen.queryByRole("option", { name: "Everybody but operators" })).toBeNull();
        expect(screen.queryByRole("option", { name: "Operators who are on" })).toBeNull();
    });

    it("will not send to nobody", async () => {
        render(
            <MinecraftAnnounce installedAppId="s1" running edition="java" players={["Steve"]} />
        );
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Hello" } });
        fireEvent.click(screen.getByRole("combobox", { name: "Send to" }));
        fireEvent.click(await screen.findByRole("option", { name: "Players I pick" }));
        expect((screen.getByRole("button", { name: /^Send$/ }) as HTMLButtonElement).disabled).toBe(
            true
        );
        expect(screen.getByRole("alert").textContent).toBe("Choose who it goes to");
    });
});
