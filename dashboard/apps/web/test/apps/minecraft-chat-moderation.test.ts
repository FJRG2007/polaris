/**
 * Chat moderation in the game: the rules an operator sets and what the server is
 * sent to apply them.
 *
 * What is pinned: it is on by default and blocks advertising, flooding and
 * repeats, reusing Polaris Chat's own limits; a stored copy is read totally
 * (older copies get new fields' defaults, junk reads as the defaults); the
 * payload carries everything the shared Java engine reads, under the names it
 * reads them by; a timeout comes after the operator's number of stops, with the
 * one before it saying so; and both server builds compile the shared engine in.
 */

import { join } from "node:path";
import * as core from "@polaris/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as moderation from "@polaris-app/game-servers/src/lib/minecraft/chat-moderation";

const RESOURCES = join(__dirname, "../../../../resources/minecraft");

describe("chat moderation rules", () => {
    it("start on, blocking advertising, flooding and repeats with Polaris Chat's limits", () => {
        const rules = moderation.readChatModeration({});
        expect(rules).toMatchObject({
            enabled: true,
            advertising: true,
            flood: true,
            repeats: true,
            links: false,
            caps: false,
            words: [],
            maxPerMinute: core.DEFAULT_CHAT_RULES.maxPerMinute,
            maxRepeated: core.DEFAULT_CHAT_RULES.maxRepeatedMessages
        });
    });

    it("read a stored copy totally", () => {
        expect(
            moderation.readChatModeration({ [moderation.CHAT_MODERATION_KEY]: { links: true } })
        ).toMatchObject({ links: true, advertising: true, strikes: 3 });
        expect(moderation.readChatModeration({ [moderation.CHAT_MODERATION_KEY]: "junk" })).toEqual(
            moderation.DEFAULT_CHAT_MODERATION
        );
        expect(
            moderation.readChatModeration({ [moderation.CHAT_MODERATION_KEY]: { strikes: -4 } })
        ).toEqual(moderation.DEFAULT_CHAT_MODERATION);
    });

    it("take allowed addresses as host names or IPs, however they were pasted", () => {
        const parsed = moderation.chatModerationSchema.parse({
            allowedDomains: ["https://Play.Example.net/vote", "10.0.0.5", "mc.example.gg:25565"]
        });
        expect(parsed.allowedDomains).toEqual(["play.example.net", "10.0.0.5", "mc.example.gg"]);
        expect(moderation.chatModerationSchema.safeParse({ allowedDomains: ["not a host"] }).success).toBe(
            false
        );
    });

    it("keep each word and address once", () => {
        const tidy = moderation.tidy({
            ...moderation.DEFAULT_CHAT_MODERATION,
            words: ["Spam", "spam", "scam"],
            allowedDomains: ["a.net", "a.net"]
        });
        expect(tidy.words).toEqual(["Spam", "scam"]);
        expect(tidy.allowedDomains).toEqual(["a.net"]);
    });
});

describe("what the server is sent", () => {
    const fallback = Object.fromEntries(
        moderation.BLOCK_REASONS.map((reason) => [reason, `no ${reason}`])
    ) as Record<moderation.BlockReason, string>;

    it("carries every field the shared engine reads", () => {
        const payload = moderation.rulesPayload(moderation.DEFAULT_CHAT_MODERATION, fallback);
        const engine = readFileSync(
            join(RESOURCES, "polaris-common/src/chat/java/polaris/minecraft/chat/ChatRules.java"),
            "utf8"
        );
        const read = [...engine.matchAll(/(?:flag|number|texts)\(body, "(\w+)"/g)].map((match) => match[1]);
        expect(read.length).toBeGreaterThan(10);
        for (const field of read) expect(payload).toHaveProperty(field!);
        expect(payload).toMatchObject({
            enabled: true,
            burstLines: moderation.BURST_LINES,
            repeatMs: core.CHAT_SPAM_WINDOWS.repeatedMs,
            commands: moderation.CHAT_COMMANDS,
            fallback
        });
        expect(payload.topLevelDomains).toContain("net");
        expect(payload.topLevelDomains).not.toContain("me");
    });

    it("names the reasons the engine stops lines for", () => {
        const guard = readFileSync(
            join(RESOURCES, "polaris-common/src/chat/java/polaris/minecraft/chat/ChatGuard.java"),
            "utf8"
        );
        const reasons = [...guard.matchAll(/public static final String \w+ = "(\w+)";/g)].map((match) => match[1]);
        expect(reasons.sort()).toEqual([...moderation.BLOCK_REASONS].sort());
    });
});

describe("what follows a stopped line", () => {
    const rules = moderation.DEFAULT_CHAT_MODERATION;

    it("warns, warns that the next one counts, then times out", () => {
        expect(moderation.consequence(rules, 1)).toEqual({ action: "warn", lastWarning: false });
        expect(moderation.consequence(rules, 2)).toEqual({ action: "warn", lastWarning: true });
        expect(moderation.consequence(rules, 3)).toEqual({ action: "timeout", lastWarning: false });
    });

    it("never times out when the operator says so", () => {
        expect(moderation.consequence({ ...rules, strikes: 0 }, 50)).toEqual({
            action: "warn",
            lastWarning: false
        });
    });
});

describe("the server builds", () => {
    it("compile the shared engine into the mod and the anti-cheat plugin", () => {
        expect(readFileSync(join(RESOURCES, "polaris-neoforge/build.gradle"), "utf8")).toContain(
            "../polaris-common/src/chat/java"
        );
        expect(readFileSync(join(RESOURCES, "polaris-anticheat/bukkit/build.gradle.kts"), "utf8")).toContain(
            "../../polaris-common/src/chat/java"
        );
        const dockerfile = readFileSync(join(RESOURCES, "../../docker/Dockerfile"), "utf8");
        expect(dockerfile).toContain("COPY resources/minecraft/polaris-common/src/chat/ /polaris-common/src/chat/");
    });
});
