import { describe, expect, it } from "vitest";
import * as speech from "@polaris-app/game-servers/src/lib/minecraft/speech";

const hello = (language: speech.Language) => (language === "es" ? "&aHola" : "&aHello");
const messages = speech.spoken({
    hello,
    named: (name: string, language: speech.Language) =>
        language === "es" ? `Hola ${name}` : `Hi ${name}`,
    buttons: (language: speech.Language) => ({
        label: language === "es" ? "[Unirse]" : "[Join]",
        size: 3
    }),
    same: (language: speech.Language) => (language === "es" ? "Robot" : "Robot")
});

const both = speech.audienceOf(
    "en",
    new Map<string, speech.Language>([
        ["ana", "es"],
        ["ben", "en"]
    ])
);
const onlyEnglish = speech.audienceOf("en", new Map([["ben", "en"]]));

describe("a message in every language", () => {
    it("is one token that each language reads its own way, and plain words when they agree", () => {
        const line = messages.hello(speech.EVERY);
        expect(speech.speaks(line)).toBe(true);
        expect(speech.said(line, "es")).toBe("&aHola");
        expect(speech.said(line, "en")).toBe("&aHello");
        expect(messages.same(speech.EVERY)).toBe("Robot");
        expect(messages.hello("es")).toBe("&aHola");
    });

    it("keeps a token given as an argument, and merges a record word by word", () => {
        const line = messages.named(messages.hello(speech.EVERY), speech.EVERY);
        expect(speech.said(line, "es")).toBe("Hola &aHola");
        const buttons = messages.buttons(speech.EVERY);
        expect(speech.said(buttons.label, "es")).toBe("[Unirse]");
        expect(buttons.size).toBe(3);
    });
});

describe("a line on its way to the server", () => {
    it("goes out untouched when nothing in it is written in every language", () => {
        const line = `tellraw @a ${speech.formatted("&aHello")}`;
        expect(speech.localize(line, both)).toEqual([line]);
    });

    it("reaches each language's readers once, formatted as it would be alone", () => {
        const line = `tellraw @a ${speech.formatted(`&6[Event] ${messages.hello(speech.EVERY)}`)}`;
        const out = speech.localize(line, both);
        expect(out).toEqual([
            `tellraw @a[tag=!pl_es] ${speech.formatted("&6[Event] &aHello")}`,
            `tellraw @a[tag=pl_es] ${speech.formatted("&6[Event] &aHola")}`
        ]);
    });

    it("narrows a selector that already has arguments, brackets inside them and all", () => {
        const line = `execute as @a[scores={pe_join=1..},nbt={Inventory:[{}]}] run tellraw @s ${speech.formatted(messages.hello(speech.EVERY))}`;
        const out = speech.localize(line, both);
        expect(out[0]).toContain(
            "@a[scores={pe_join=1..},nbt={Inventory:[{}]},tag=!pl_es] run tellraw @s"
        );
        expect(out[1]).toContain(
            "@a[scores={pe_join=1..},nbt={Inventory:[{}]},tag=pl_es] run tellraw @s"
        );
    });

    it("is sent once, to everybody, when everybody online reads the same language", () => {
        const line = `title @a title ${speech.formatted(messages.hello(speech.EVERY))}`;
        expect(speech.localize(line, onlyEnglish)).toEqual([
            `title @a title ${speech.formatted("&aHello")}`
        ]);
    });

    it("reaches one player in that player's language, and a stranger in the server's", () => {
        const text = speech.formatted(messages.hello(speech.EVERY));
        expect(speech.localize(`tellraw Ana ${text}`, both)).toEqual([
            `tellraw Ana ${speech.formatted("&aHola")}`
        ]);
        expect(speech.localize(`title Zed actionbar ${text}`, both)).toEqual([
            `title Zed actionbar ${speech.formatted("&aHello")}`
        ]);
    });

    it("never takes an @a in the words for the selector", () => {
        const text = speech.formatted(`${messages.hello(speech.EVERY)} @a`);
        expect(speech.localize(`tellraw Ana ${text}`, both)).toEqual([
            `tellraw Ana ${speech.formatted("&aHola @a")}`
        ]);
    });

    it("writes what nobody in particular reads in the server's own language", () => {
        const line = `bossbar set polaris:event name ${speech.formatted(messages.hello(speech.EVERY))}`;
        expect(speech.localize(line, speech.audienceOf("es", both.of))).toEqual([
            `bossbar set polaris:event name ${speech.formatted("&aHola")}`
        ]);
    });

    it("puts each language's words into a token left inside the JSON of a button", () => {
        const label = messages.buttons(speech.EVERY).label;
        const json = JSON.stringify(["", { text: label, color: "green" }]).replace(
            /[\u0080-\uffff]/g,
            (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
        );
        const out = speech.localize(`tellraw @a ${json}`, both);
        expect(out).toEqual([
            'tellraw @a[tag=!pl_es] ["",{"text":"[Join]","color":"green"}]',
            'tellraw @a[tag=pl_es] ["",{"text":"[Unirse]","color":"green"}]'
        ]);
    });
});

describe("what a Polaris account's language is to the game", () => {
    it("is Spanish for any Spanish, and English for everything else", () => {
        expect(speech.gameLanguage("es-ES")).toBe("es");
        expect(speech.gameLanguage("es-MX")).toBe("es");
        expect(speech.gameLanguage("en-US")).toBe("en");
        expect(speech.gameLanguage("fr-FR")).toBe("en");
        expect(speech.gameLanguage(null)).toBe("en");
        expect(speech.tagLines("Ana", "es")).toEqual(["tag Ana remove pl_en", "tag Ana add pl_es"]);
    });
});
