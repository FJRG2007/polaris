/**
 * `@everyone` and `@here`.
 *
 * Stored as the text somebody typed, so what is being tested is a reader over
 * that text - and the cases that matter are the ones where it must NOT fire. A
 * mention that wakes a room of forty because somebody wrote an email address, or
 * because they pasted a snippet showing a colleague how to use one, is a feature
 * people turn off.
 *
 * The detector goes through the Markdown parse rather than over the raw string,
 * which is what makes the code cases work: a fence is code, not a room.
 */

import { describe, expect, it } from "vitest";
import { channelMentions, splitChannelMentions } from "../../src/components/rich-text/markdown";

const named = (markdown: string) => [...channelMentions(markdown)].sort();

describe("naming the room", () => {
    it("finds either", () => {
        expect(named("@everyone stand-up in five")).toEqual(["everyone"]);
        expect(named("anybody about? @here")).toEqual(["here"]);
    });

    it("finds both when a message carries both", () => {
        expect(named("@here now, @everyone by Friday")).toEqual(["everyone", "here"]);
    });

    it("finds one at the very start and the very end", () => {
        expect(named("@everyone")).toEqual(["everyone"]);
        expect(named("please read this @here")).toEqual(["here"]);
    });
});

describe("what is not naming the room", () => {
    it("is a longer word that starts the same way", () => {
        expect(named("@everyones problem")).toEqual([]);
        expect(named("@hereford is a place")).toEqual([]);
        expect(named("@here-ish")).toEqual([]);
    });

    it("is part of an address", () => {
        // The one that would fire on ordinary messages if this matched
        // anywhere: an email is `@` followed by a word.
        expect(named("write to ops@here.example.com")).toEqual([]);
        expect(named("me@@everyone")).toEqual([]);
    });

    it("is a code fence, which is where somebody shows one to a colleague", () => {
        expect(named("```\n@everyone\n```")).toEqual([]);
        expect(named("```sh\necho @here\n```")).toEqual([]);
    });

    it("is inline code, for the same reason", () => {
        expect(named("type `@everyone` to reach the room")).toEqual([]);
    });

    it("is a message with neither in it", () => {
        expect(named("just a normal message")).toEqual([]);
        expect(named("")).toEqual([]);
    });
});

describe("drawing it", () => {
    it("splits the mention out of the text around it", () => {
        expect(splitChannelMentions("hi @here now")).toEqual([
            { text: "hi ", mention: null },
            { text: "@here", mention: "here" },
            { text: " now", mention: null }
        ]);
    });

    it("leaves text with none in it in one piece", () => {
        // What keeps a span from going around every word of every message.
        expect(splitChannelMentions("nothing to see")).toEqual([
            { text: "nothing to see", mention: null }
        ]);
    });

    it("splits several", () => {
        const parts = splitChannelMentions("@everyone and @here");
        expect(parts.filter((part) => part.mention).map((part) => part.text)).toEqual([
            "@everyone",
            "@here"
        ]);
    });
});

describe("@all", () => {
    it("is the same thing as @everyone, because it is what half of people type", () => {
        expect(named("@all please read this")).toEqual(["everyone"]);
    });

    it("is drawn as what was written rather than corrected", () => {
        // Rewriting somebody's message to say a word they did not use is not
        // this file's job.
        const parts = splitChannelMentions("@all now");
        expect(parts[0]).toEqual({ text: "@all", mention: "everyone" });
    });

    it("is still only a whole word", () => {
        expect(named("@allocation of the budget")).toEqual([]);
    });
});
