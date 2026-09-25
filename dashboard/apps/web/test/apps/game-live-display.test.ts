/**
 * The words Polaris fills into what it puts on players' screens, how long it
 * keeps it there, and the side panel.
 *
 * Each rule here is one a player sees broken: a fallback that never shows, a
 * name read from the wrong account, a panel that forgets a line, a line on
 * screen for three seconds that was meant to stay a minute.
 */

import { describe, expect, it } from "vitest";
import {
    BLANK_ANNOUNCEMENT,
    announcementCommands,
    announcementProblems,
    holdEndsAt,
    javaComponent,
    needsRepeating,
    type Announcement,
    type SendContext
} from "@polaris-app/game-servers/src/lib/minecraft/announcement";
import {
    fillValues,
    previewText,
    variableProblem,
    visibleLength
} from "@polaris-app/game-servers/src/lib/minecraft/text-vars";
import {
    DEFAULT_SIDEBAR,
    readSidebar,
    sidebarCommands,
    sidebarProblems,
    sidebarSupported
} from "@polaris-app/game-servers/src/lib/minecraft/sidebar";

const draft = (over: Partial<Announcement>): Announcement => ({ ...BLANK_ANNOUNCEMENT, ...over });
const NOW = Date.parse("2026-09-25T20:00:00Z");

describe("filling in the words", () => {
    it("writes the server's values, and the fallback where there is none", () => {
        expect(
            fillValues('{server.online} on, {call.members | "nobody in the call"}', {
                "server.online": "3",
                "call.members": null
            })
        ).toBe("3 on, nobody in the call");
    });

    it("leaves the game's own variables for the game, whatever fallback they carry", () => {
        expect(fillValues('Hi {player | "you"}, level {player.level}', {})).toBe(
            "Hi {player}, level {player.level}"
        );
    });

    it("keeps a value from formatting the line or opening a variable of its own", () => {
        expect(fillValues("{polaris.name}", { "polaris.name": "&cAda {player}" })).toBe(
            "cAda player"
        );
    });

    it("draws a level as the score the game keeps for it", () => {
        expect(JSON.parse(javaComponent("&aLevel {player.level}", false))).toEqual([
            { text: "" },
            { text: "Level ", color: "green" },
            { score: { name: "@s", objective: "polaris_level" }, color: "green" }
        ]);
    });

    it("previews every variable at a sample, or at the value it is given", () => {
        expect(previewText("{player} has {server.online}", { player: "Alex" })).toBe("Alex has 3");
    });
});

describe("checking what was written", () => {
    it("names a variable that does not exist", () => {
        expect(variableProblem("Hi {palyer}", "java")).toBe(
            "{palyer} is not something Polaris can fill in"
        );
    });

    it("refuses a brace that is not a variable", () => {
        expect(variableProblem("Hi {player", "java")).toMatch(/has to hold a variable/);
    });

    it("refuses what Bedrock cannot draw there, and nowhere else", () => {
        expect(variableProblem("{player.level}", "bedrock")).toBe(
            "Bedrock cannot show {player.level}"
        );
        expect(variableProblem("{player.level}", "java")).toBeNull();
    });

    it("counts a variable at the widest value it takes, not at its name", () => {
        expect(visibleLength("{player}!")).toBe(17);
        expect(visibleLength('{polaris.name | "a fallback longer than thirty-two"}')).toBe(33);
    });

    it("puts each problem under its field", () => {
        const problems = announcementProblems(
            draft({ title: "x".repeat(121), chat: "a\nb\nc\nd\ne", hold: "until", until: "" }),
            "java",
            NOW
        );
        expect(problems.title).toBe("At most 120 characters on screen");
        expect(problems.chat).toBe("At most 4 lines");
        expect(problems.until).toBe("Choose when it comes down");
    });

    it("refuses an until that has passed, or is more than a week off", () => {
        const at = (iso: string) =>
            announcementProblems(draft({ actionbar: "Hi", hold: "until", until: iso }), "java", NOW)
                .until;
        expect(at("2026-09-25T19:00:00Z")).toBe("That moment has already passed");
        expect(at("2026-10-05T20:00:00Z")).toBe("At most a week from now");
        expect(at("2026-09-25T21:00:00Z")).toBeUndefined();
    });

    it("keeps only something on screen held: a chat line cannot stay", () => {
        expect(
            announcementProblems(draft({ chat: "Hi", hold: "manual" }), "java", NOW).hold
        ).toMatch(/Only the title/);
    });
});

describe("writing it once per player when it reads their account", () => {
    const context: SendContext = {
        values: { "server.online": "2" },
        recipients: [
            { name: "Steve", values: { "polaris.name": "Ada" } },
            { name: "Alex", values: { "polaris.name": null } }
        ]
    };

    it("sends each player their own account's name, or the fallback", () => {
        const lines = announcementCommands(
            "java",
            draft({ actionbar: 'Hi {polaris.name | "friend"}, {server.online} online' }),
            context
        );
        expect(lines).toEqual([
            `execute as Steve run title @s actionbar ${javaComponent("Hi Ada, 2 online", false)}`,
            `execute as Alex run title @s actionbar ${javaComponent("Hi friend, 2 online", false)}`
        ]);
    });

    it("sends one player only theirs", () => {
        const lines = announcementCommands(
            "java",
            draft({ target: "alex", actionbar: '{polaris.name | "friend"}' }),
            context
        );
        expect(lines).toEqual([
            `execute as Alex run title @s actionbar ${javaComponent("friend", false)}`
        ]);
    });

    it("writes the fallback for everybody when who is online is not known", () => {
        const lines = announcementCommands(
            "java",
            draft({ actionbar: '{polaris.name | "friend"}' }),
            { values: {}, recipients: null }
        );
        expect(lines).toEqual([`title @a actionbar ${javaComponent("friend", false)}`]);
    });

    it("creates the scores a line reads before it goes", () => {
        const lines = announcementCommands("java", draft({ title: "Level {player.level}" }));
        expect(lines[0]).toBe("scoreboard objectives add polaris_level level");
        expect(lines.at(-1)).toMatch(/^execute as @a run title @s title /);
    });
});

describe("keeping it on screen", () => {
    it("sends an action bar again when it is meant to outlast the game's three seconds", () => {
        expect(needsRepeating(draft({ actionbar: "Hi", stay: 60 }))).toBe(true);
        expect(needsRepeating(draft({ actionbar: "Hi", stay: 2 }))).toBe(false);
        expect(needsRepeating(draft({ title: "Hi", stay: 60 }))).toBe(false);
        expect(needsRepeating(draft({ title: "Hi", hold: "manual" }))).toBe(true);
    });

    it("comes down at its moment, after its time, or never on its own", () => {
        expect(holdEndsAt(draft({ actionbar: "Hi", stay: 60 }), NOW)).toBe(NOW + 60_000);
        expect(holdEndsAt(draft({ hold: "until", until: "2026-09-25T21:00:00.000Z" }), NOW)).toBe(
            Date.parse("2026-09-25T21:00:00.000Z")
        );
        expect(holdEndsAt(draft({ hold: "manual" }), NOW)).toBeNull();
    });

    it("repeats only the part that fades, without fading the title in again", () => {
        const held = draft({ title: "Event", actionbar: "Go", chat: "Once", hold: "manual" });
        expect(announcementCommands("java", held, undefined, "actionbar")).toEqual([
            `title @a actionbar ${javaComponent("Go", false)}`
        ]);
        const title = announcementCommands("java", held, undefined, "title");
        expect(title[0]).toBe("title @a times 0 240 20");
        expect(title.some((line) => line.includes("tellraw"))).toBe(false);
    });
});

describe("the side panel", () => {
    it("is only for Java 1.20.3 and newer", () => {
        expect(sidebarSupported("java", "1.20.2")).toBe(false);
        expect(sidebarSupported("java", "1.20.3")).toBe(true);
        expect(sidebarSupported("java", "1.21.4")).toBe(true);
        expect(sidebarSupported("java", null)).toBe(true);
        expect(sidebarSupported("bedrock", "1.21.4")).toBe(false);
    });

    it("refuses anything of one player's, since everybody sees the same panel", () => {
        const problems = sidebarProblems({ ...DEFAULT_SIDEBAR, lines: ["Hi {player}", "ok"] });
        expect(problems.lines[0]).toMatch(/same for everybody/);
        expect(problems.lines[1]).toBeNull();
    });

    it("is written whole the first time, clearing whatever was there", () => {
        const lines = sidebarCommands("Server", ["a", "b"], null);
        expect(lines.slice(0, 4)).toEqual([
            "scoreboard objectives remove polaris_side",
            `scoreboard objectives add polaris_side dummy ${javaComponent("Server", false)}`,
            "scoreboard objectives modify polaris_side numberformat blank",
            "scoreboard objectives setdisplay sidebar polaris_side"
        ]);
        expect(lines).toContain("scoreboard players set polaris.line.01 polaris_side 2");
        expect(lines).toContain("scoreboard players set polaris.line.02 polaris_side 1");
    });

    it("afterwards sends only the line that changed, and drops lines that went", () => {
        const shown = { title: "Server", lines: ["a", "b", "c"] };
        expect(sidebarCommands("Server", ["a", "B", "c"], shown)).toEqual([
            `scoreboard players display name polaris.line.02 polaris_side ${javaComponent("B", false)}`
        ]);
        const fewer = sidebarCommands("Server", ["a"], shown);
        expect(fewer).toContain("scoreboard players reset polaris.line.02 polaris_side");
        expect(fewer).toContain("scoreboard players reset polaris.line.03 polaris_side");
    });

    it("reads a stored panel that no longer passes as the default", () => {
        expect(readSidebar({ sidebar: { enabled: "yes" } })).toEqual(DEFAULT_SIDEBAR);
    });
});

describe("the panel a server starts with", () => {
    it("passes its own checks, so switching it on is one press", () => {
        const problems = sidebarProblems({ ...DEFAULT_SIDEBAR, enabled: true });
        expect(problems.title).toBeUndefined();
        expect(problems.count).toBeUndefined();
        expect(problems.lines.every((line) => line === null)).toBe(true);
    });
});
