/**
 * Chat moderation in the game: the rules an operator sets on the Moderation tab,
 * and what the server is sent to apply them.
 *
 * Vanilla Minecraft has no way to stop a chat line, so the rules are applied by
 * Polaris's own code on the server, which cancels the line before anybody sees
 * it: the Polaris mod on NeoForge (its `ServerChatEvent` listener) and Polaris's
 * anti-cheat plugin on Paper, Purpur, Spigot and Folia (`AsyncPlayerChatEvent`).
 * Both share one engine (`resources/minecraft/polaris-common/src/chat`) and take
 * the rules from here every half minute; each line they stop comes back to be
 * kept for the tab, counted towards a timeout, and answered with the warning in
 * the player's language.
 *
 * The limits reuse Polaris Chat's own (`@polaris/core` chat rules): a line a
 * minute cap of the same default, and the same "the same line three times in two
 * minutes" repeat rule. The burst limit is the game's own addition: a chat
 * flooded by a bot is five lines in a second, which a per-minute cap alone lets
 * through before it bites.
 *
 * Pure.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { gameMessage } from "../game-message";

/** The install config key the rules live under. */
export const CHAT_MODERATION_KEY = "chatModeration";

/** Why a line was stopped, as the server reports it. */
export const BLOCK_REASONS = ["flood", "repeat", "caps", "link", "advertising", "word"] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/** A few lines in a few seconds: faster than anybody types, slower than a bot. */
export const BURST_LINES = 5;
export const BURST_MS = 5_000;

/** A line counts as shouting from this many letters, this share of them capitals. */
export const CAPS_MIN_LETTERS = 8;
export const CAPS_PERCENT = 70;

/** How far back a player's stopped lines count towards a timeout. */
export const STRIKE_WINDOW_MS = 10 * 60_000;

/** How long a stopped line is kept for the tab. */
export const LOG_KEEP_MS = 14 * 24 * 3_600_000;

/**
 * The commands that carry chat and would otherwise be the way round the rules.
 * `say` needs an operator, who is left alone anyway, but a permissions mod can
 * hand it out.
 */
export const CHAT_COMMANDS = ["me", "msg", "tell", "w", "teammsg", "tm", "say"] as const;

/**
 * The top-level domains a server address is read on. Deliberately not every one
 * there is: many are also everyday words or file extensions (`.me`, `.so`,
 * `.md`, `.py`), and a false match stops somebody's sentence. These are the ones
 * server addresses are actually handed out on.
 */
export const SERVER_TLDS: readonly string[] = [
    "com", "net", "org", "gg", "io", "co", "us", "uk", "eu", "de", "es", "fr", "it", "nl",
    "pl", "ru", "br", "mx", "ar", "cl", "pe", "uy", "ve", "ec", "cz", "sk", "hu", "ro", "tr",
    "ua", "pt", "be", "ch", "at", "se", "no", "dk", "fi", "ca", "au", "nz", "jp", "kr", "cn",
    "tw", "vn", "id", "ph", "in", "info", "biz", "xyz", "club", "fun", "pro", "online", "site",
    "space", "host", "games", "live", "world", "top", "tv", "cc", "ws", "tk", "ml", "ga", "cf",
    "gq", "network", "one", "store", "icu", "me.uk", "play", "zone", "cloud", "dev", "app"
];

const domain = z
    .string()
    .trim()
    .toLowerCase()
    .transform((value) => value.replace(/^https?:\/\//, "").replace(/[/:].*$/, ""))
    .pipe(
        z
            .string()
            .min(3)
            .max(253)
            .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$|^\d{1,3}(?:\.\d{1,3}){3}$/, {
                message: gameMessage("minecraft", "moderation.chat.badDomain")
            })
    );

const word = z.string().trim().min(1).max(64);

/** One server's rules. Every number is coerced: the form hands over strings. */
export const chatModerationSchema = z.object({
    /** On unless the operator turns it off. */
    enabled: z.boolean().default(true),
    flood: z.boolean().default(true),
    maxPerMinute: z.coerce
        .number()
        .int()
        .min(1)
        .max(core.CHAT_RATE_CEILING)
        .default(core.DEFAULT_CHAT_RULES.maxPerMinute),
    repeats: z.boolean().default(true),
    maxRepeated: z.coerce
        .number()
        .int()
        .min(1)
        .max(core.CHAT_SPAM_CEILINGS.repeatedMessages)
        .default(core.DEFAULT_CHAT_RULES.maxRepeatedMessages),
    caps: z.boolean().default(false),
    /** Any web address. Off by default: players share links to builds and maps. */
    links: z.boolean().default(false),
    /** Another server's address: an IP, or a host name. */
    advertising: z.boolean().default(true),
    /** Addresses that are fine to name: this server's own, a partner's. */
    allowedDomains: z.array(domain).max(50).default([]),
    words: z.array(word).max(500).default([]),
    /** Stopped lines within ten minutes before a timeout; zero never times out. */
    strikes: z.coerce.number().int().min(0).max(20).default(3),
    timeoutMinutes: z.coerce.number().int().min(1).max(1_440).default(10)
});

export type ChatModeration = z.infer<typeof chatModerationSchema>;

export const DEFAULT_CHAT_MODERATION: ChatModeration = chatModerationSchema.parse({});

/** The rules out of the install config, whatever is stored there. A stored copy
 *  older than a field gets that field's default; one that no longer parses is
 *  read as the defaults rather than failing the tab. */
export function readChatModeration(config: Record<string, unknown>): ChatModeration {
    const stored = config[CHAT_MODERATION_KEY];
    const parsed = chatModerationSchema.safeParse(
        stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}
    );
    return parsed.success ? parsed.data : DEFAULT_CHAT_MODERATION;
}

/** Words and domains once each, in the order first given. */
export function tidy(rules: ChatModeration): ChatModeration {
    const once = (values: readonly string[]) => {
        const seen = new Set<string>();
        return values.filter((value) => {
            const key = value.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    };
    return { ...rules, words: once(rules.words), allowedDomains: once(rules.allowedDomains) };
}

/** What the server is sent: the rules in the engine's own names, and the
 *  warnings to fall back on, in the server's language, while Polaris is out of
 *  reach. */
export function rulesPayload(
    rules: ChatModeration,
    fallback: Readonly<Record<BlockReason, string>>
): Record<string, unknown> {
    return {
        enabled: rules.enabled,
        flood: rules.flood,
        maxPerMinute: rules.maxPerMinute,
        burstLines: BURST_LINES,
        burstMs: BURST_MS,
        repeats: rules.repeats,
        maxRepeated: rules.maxRepeated,
        repeatMs: core.CHAT_SPAM_WINDOWS.repeatedMs,
        caps: rules.caps,
        capsMinLetters: CAPS_MIN_LETTERS,
        capsPercent: CAPS_PERCENT,
        links: rules.links,
        advertising: rules.advertising,
        exemptOperators: true,
        allowedDomains: rules.allowedDomains,
        topLevelDomains: SERVER_TLDS,
        words: rules.words,
        commands: CHAT_COMMANDS,
        fallback
    };
}

/** What happens to a player after this stop: `strikes` counts this one. */
export function consequence(
    rules: ChatModeration,
    strikes: number
): { readonly action: "warn" | "timeout"; readonly lastWarning: boolean } {
    if (rules.strikes === 0) return { action: "warn", lastWarning: false };
    if (strikes >= rules.strikes) return { action: "timeout", lastWarning: false };
    return { action: "warn", lastWarning: strikes === rules.strikes - 1 };
}
