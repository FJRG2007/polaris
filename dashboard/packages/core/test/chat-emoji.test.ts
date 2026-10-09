/**
 * A space's own emoji, as text: the names it may have and the token it is
 * stored as.
 *
 * The browser and the server both run these, so what the settings page says
 * about a name as it is typed is what the server says when it is saved.
 */

import { describe, expect, it } from "vitest";
import * as emoji from "../src/chat-emoji.js";
import { chatReactSchema } from "../src/schemas/chat.js";

const ID = "0193b0f0-0000-7000-8000-00000000000a";
const OTHER = "0193b0f0-0000-7000-8000-00000000000b";

describe("an emoji's name", () => {
    it("takes letters, digits and underscores, 2 to 32 of them", () => {
        expect(emoji.emojiNameProblem("ok")).toBeNull();
        expect(emoji.emojiNameProblem("party_parrot2")).toBeNull();
        expect(emoji.emojiNameProblem("a".repeat(32))).toBeNull();
    });

    it("says what is wrong with one it refuses", () => {
        expect(emoji.emojiNameProblem("a")).toBe("short");
        expect(emoji.emojiNameProblem("a".repeat(33))).toBe("long");
        expect(emoji.emojiNameProblem("no-dash")).toBe("characters");
        expect(emoji.emojiNameProblem("con espacio")).toBe("characters");
        expect(emoji.emojiNameProblem("ñandú")).toBe("characters");
        // Markdown would read `_x_` as emphasis around the token.
        expect(emoji.emojiNameProblem("_edge")).toBe("edges");
        expect(emoji.emojiNameProblem("edge_")).toBe("edges");
    });

    it("is trimmed and loses the colons somebody typed around it", () => {
        expect(emoji.normalizeEmojiName("  :wave:  ")).toBe("wave");
        expect(emoji.customEmojiNameSchema.parse(" :Wave: ")).toBe("Wave");
    });

    it("is refused by the schema with the same word the screen keys on", () => {
        const parsed = emoji.customEmojiNameSchema.safeParse("x");
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]?.message).toBe("short");
    });

    it("is compared ignoring case", () => {
        expect(emoji.customEmojiNameKey("PartyParrot")).toBe(emoji.customEmojiNameKey("partyparrot"));
    });

    it("is offered from the file's name", () => {
        expect(emoji.emojiNameFromFile("party-parrot.gif")).toBe("party_parrot");
        expect(emoji.emojiNameFromFile("My Cat (1).PNG")).toMatch(/^[A-Za-z0-9_]+$/);
        expect(emoji.emojiNameProblem(emoji.emojiNameFromFile("thumbs up!!.webp"))).toBeNull();
    });
});

describe("the stored token", () => {
    it("is Discord's shape, with an a for an animated one", () => {
        expect(emoji.customEmojiToken({ id: ID, name: "wave", animated: false })).toBe(`<:wave:${ID}>`);
        expect(emoji.customEmojiToken({ id: ID, name: "wave", animated: true })).toBe(`<a:wave:${ID}>`);
    });

    it("reads back what it wrote, and nothing else", () => {
        expect(emoji.parseCustomEmojiToken(`<a:wave:${ID}>`)).toEqual({ id: ID, name: "wave", animated: true });
        expect(emoji.parseCustomEmojiToken(`<:wave:${ID.toUpperCase()}>`)?.id).toBe(ID);
        expect(emoji.parseCustomEmojiToken("<:wave:not-an-id>")).toBeNull();
        expect(emoji.parseCustomEmojiToken(`<:w:${ID}>`)).toBeNull();
        expect(emoji.parseCustomEmojiToken(`x <:wave:${ID}>`)).toBeNull();
    });

    it("is found inside text and split out of it", () => {
        const text = `hi <:wave:${ID}> and <a:dance:${OTHER}>!`;
        expect(emoji.customEmojiRefs(text).map((ref) => ref.name)).toEqual(["wave", "dance"]);
        const parts = emoji.splitCustomEmoji(text);
        expect(parts.map((part) => part.emoji?.name ?? part.text)).toEqual(["hi ", "wave", " and ", "dance", "!"]);
    });

    it("reads as its name where it cannot be drawn", () => {
        expect(emoji.customEmojiFallback({ name: "wave" })).toBe(":wave:");
        expect(emoji.customEmojiAsText(`hi <:wave:${ID}>`)).toBe("hi :wave:");
        expect(emoji.replaceCustomEmoji(`<:a1:${ID}>`, () => "X")).toBe("X");
    });

    it("is a reaction the schema takes, alongside an ordinary emoji", () => {
        const messageId = OTHER;
        expect(chatReactSchema.safeParse({ messageId, emoji: `<:wave:${ID}>` }).success).toBe(true);
        expect(chatReactSchema.safeParse({ messageId, emoji: "👍" }).success).toBe(true);
        expect(chatReactSchema.safeParse({ messageId, emoji: "<:wave:nope>" }).success).toBe(false);
    });
});

describe("a message that is only emoji", () => {
    it("counts tokens and ordinary emoji alike", () => {
        expect(emoji.emojiOnlyCount(`<:wave:${ID}>`)).toBe(1);
        expect(emoji.emojiOnlyCount(`<:wave:${ID}> 👍 <a:dance:${OTHER}>`)).toBe(3);
        expect(emoji.emojiOnlyCount("👨‍👩‍👧")).toBe(1);
    });

    it("is not one once there is a word in it", () => {
        expect(emoji.emojiOnlyCount(`hi <:wave:${ID}>`)).toBe(0);
        expect(emoji.emojiOnlyCount("")).toBe(0);
        expect(emoji.emojiOnlyCount("123")).toBe(0);
    });
});
