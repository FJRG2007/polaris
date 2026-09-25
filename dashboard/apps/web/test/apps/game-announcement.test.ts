/**
 * An announcement, written with colour codes, and the commands that draw it.
 *
 * The preview and the send both read these, so an assertion here is a promise
 * about what the players see.
 */

import { describe, expect, it } from "vitest";
import {
    BLANK_ANNOUNCEMENT,
    announcementCommands,
    bedrockComponent,
    isAnnouncementTarget,
    javaComponent,
    type Announcement
} from "@polaris-app/game-servers/src/lib/minecraft/announcement";
import {
    MAX_TEMPLATES,
    readTemplates,
    withTemplate
} from "@polaris-app/game-servers/src/lib/minecraft/announcement-templates";

const draft = (over: Partial<Announcement>): Announcement => ({ ...BLANK_ANNOUNCEMENT, ...over });

describe("the text as Java draws it", () => {
    it("names the sixteen colours and styles each run on its own", () => {
        expect(JSON.parse(javaComponent("&6&lDymo&r: &bRestarting", false))).toEqual([
            { text: "" },
            { text: "Dymo", color: "gold", bold: true },
            { text: ": " },
            { text: "Restarting", color: "aqua" }
        ]);
    });

    it("sends any other colour as hex", () => {
        expect(JSON.parse(javaComponent("&x&8&b&5&c&f&6Polaris", false))).toEqual([
            { text: "" },
            { text: "Polaris", color: "#8b5cf6" }
        ]);
    });

    it("puts [Polaris] in front of a chat line when asked, and keeps line breaks", () => {
        expect(JSON.parse(javaComponent("one\n&atwo", true))).toEqual([
            { text: "" },
            { text: "[Polaris] ", color: "gray" },
            { text: "one" },
            { text: "\n" },
            { text: "two", color: "green" }
        ]);
    });
});

describe("the text as Bedrock draws it", () => {
    it("writes section-sign codes, bringing a custom colour to the nearest of the sixteen", () => {
        const body = JSON.parse(bedrockComponent("&x&f&f&a&a&0&1&lHi", false)) as {
            rawtext: { text: string }[];
        };
        expect(body.rawtext[0]?.text).toBe("§r§6§lHi");
    });

    it("leaves out what Bedrock cannot draw", () => {
        const body = JSON.parse(bedrockComponent("&n&mplain", false)) as {
            rawtext: { text: string }[];
        };
        expect(body.rawtext[0]?.text).toBe("§r§fplain");
    });
});

describe("the commands, in the order the game needs them", () => {
    it("sets the timing, then the subtitle, then the title that shows both", () => {
        const lines = announcementCommands(
            "java",
            draft({ title: "&cRestart", subtitle: "soon", fadeIn: 0.5, stay: 3.5, fadeOut: 1 })
        );
        expect(lines[0]).toBe("title @a times 10 70 20");
        expect(lines[1]?.startsWith("title @a subtitle ")).toBe(true);
        expect(lines[2]?.startsWith("title @a title ")).toBe(true);
        expect(lines).toHaveLength(3);
    });

    it("sends an empty title to carry a subtitle on its own", () => {
        const lines = announcementCommands("java", draft({ subtitle: "only this" }));
        expect(lines.at(-1)).toBe('title @a title {"text":""}');
    });

    it("adds the action bar, the chat line and the sound, to one player", () => {
        const lines = announcementCommands(
            "java",
            draft({
                target: "ErMigue04",
                actionbar: "gift",
                chat: "thanks",
                sound: "minecraft:entity.player.levelup"
            })
        );
        expect(lines.map((line) => line.split(" ").slice(0, 3).join(" "))).toEqual([
            "title ErMigue04 actionbar",
            'tellraw ErMigue04 [{"text":""},{"text":"[Polaris]',
            "execute as ErMigue04"
        ]);
        expect(lines[2]).toContain("playsound minecraft:entity.player.levelup");
    });

    it("uses Bedrock's verbs there, and plays no Java sound", () => {
        const lines = announcementCommands(
            "bedrock",
            draft({ title: "Hi", chat: "yo", sound: "minecraft:entity.player.levelup" })
        );
        expect(lines[0]?.startsWith("titleraw @a times")).toBe(true);
        expect(lines.some((line) => line.includes("playsound"))).toBe(false);
        expect(lines.at(-1)?.startsWith('tellraw @a {"rawtext"')).toBe(true);
    });

    it("sends nothing for an announcement with only codes in it", () => {
        expect(announcementCommands("java", draft({ title: "&c&l", chat: "  " }))).toEqual([]);
    });

    it("never puts anything but a player name or everybody where the target goes", () => {
        expect(isAnnouncementTarget("@a")).toBe(true);
        expect(isAnnouncementTarget("ErMigue04")).toBe(true);
        expect(isAnnouncementTarget("@e[type=creeper]")).toBe(false);
        expect(isAnnouncementTarget("a b")).toBe(false);
        expect(() => announcementCommands("java", draft({ target: "@e", title: "x" }))).toThrow();
    });

    it("ignores a sound that is not on the list", () => {
        const lines = announcementCommands(
            "java",
            draft({ chat: "x", sound: "minecraft:x; stop" })
        );
        expect(lines.some((line) => line.includes("playsound"))).toBe(false);
    });
});

/**
 * "Hi {player}": each recipient reads their own name. The game resolves a
 * `@s` selector component per player when the command runs as that player, so
 * only the lines that carry the name are sent that way.
 */
describe("each player's own name", () => {
    it("draws the name as a selector, in the style of the words around it", () => {
        expect(JSON.parse(javaComponent("&6Hi {player}!", false))).toEqual([
            { text: "" },
            { text: "Hi ", color: "gold" },
            { selector: "@s", color: "gold" },
            { text: "!", color: "gold" }
        ]);
    });

    it("gives Bedrock a selector entry between the text around it", () => {
        const parsed = JSON.parse(bedrockComponent("Hi {PLAYER}", false)) as {
            rawtext: Record<string, string>[];
        };
        expect(parsed.rawtext.map((entry) => Object.keys(entry)[0])).toEqual(["text", "selector"]);
        expect(parsed.rawtext[1]).toEqual({ selector: "@s" });
        expect(parsed.rawtext[0]?.text.endsWith("Hi §r§f")).toBe(true);
    });

    it("runs only the lines that carry the name as each player", () => {
        const lines = announcementCommands(
            "java",
            draft({
                title: "Welcome {player}",
                subtitle: "Restart soon",
                chat: "See you, {player}"
            })
        );
        expect(lines).toEqual([
            "title @a times 10 70 20",
            `title @a subtitle ${javaComponent("Restart soon", false)}`,
            `execute as @a run title @s title ${javaComponent("Welcome {player}", false)}`,
            `execute as @a run tellraw @s ${javaComponent("See you, {player}", true)}`
        ]);
    });

    it("does the same for one player, and on Bedrock", () => {
        expect(
            announcementCommands("bedrock", draft({ target: "Alex", actionbar: "{player}" }))
        ).toEqual([
            `execute as Alex run titleraw @s actionbar ${bedrockComponent("{player}", false)}`
        ]);
    });

});

describe("templates a server keeps", () => {
    it("reads back only the ones that still pass", () => {
        const list = readTemplates({
            announcementTemplates: [
                { id: "a", name: "Restart", announcement: { target: "@a", title: "&cRestart" } },
                { id: "b", name: "Bad target", announcement: { target: "@e", title: "x" } },
                { id: "c", name: "", announcement: { target: "@a" } },
                "junk"
            ]
        });
        expect(list.map((one) => one.id)).toEqual(["a"]);
        expect(list[0]?.announcement.stay).toBe(3.5);
    });

    it("refuses one more than it keeps, and rewrites one in place", () => {
        const one = { id: "x", name: "One", announcement: BLANK_ANNOUNCEMENT };
        const full = Array.from({ length: MAX_TEMPLATES }, (_, index) => ({
            ...one,
            id: `t${index}`
        }));
        expect(() => withTemplate(full, one)).toThrow(/Only/);
        expect(withTemplate(full, { ...one, id: "t0", name: "Renamed" })[0]?.name).toBe("Renamed");
    });
});
