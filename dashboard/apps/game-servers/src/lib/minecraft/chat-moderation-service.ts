/**
 * Chat moderation on one server: its rules, what carries them into the game,
 * and what the game reports back (`chat-moderation.ts` holds the rules and the
 * reasons for the mechanism).
 *
 * A stopped line comes back from the server's mod or plugin; it is kept for the
 * tab, counted against the player's other stops in the last ten minutes, and -
 * past the operator's limit - turned into a timeout through the same service the
 * Players tab uses, so it is recorded as a sanction like any other. The answer is
 * the warning the player is shown, in their language: a player linked to a
 * Polaris account reads that account's, anybody else the server's own.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import type { Locale } from "@polaris/core";
import { SOFTWARE_KEY } from "./join-guard";
import { accountLanguage, homeLanguage } from "./speech-service";
import * as moderation from "./chat-moderation";
import { gameCatalogs } from "../../../messages";
import { chosenLanguage } from "./events/catalog";
import { timeoutPlayer } from "./timeout-service";
import type { Language } from "./speech";
import { MODS_KEY, URL_KEY, hasMod, loginOn } from "./polaris-login";
import { anticheatBuildFor, anticheatOn } from "./polaris-anticheat";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;
const { listEnvVars } = host.envVarService;
const { rateLimit } = host.rateLimitService;

/** The Polaris code on a server that applies the rules there. */
export type ChatCarrier = "mod" | "plugin";

/** When a server last took its rules, and with which build. */
interface Heard {
    readonly at: number;
    readonly version: string;
}

/** Kept in memory: the server asks every half minute, so a dashboard that has
 *  just started knows again within that. */
const heard = new Map<string, Heard>();

/** When this process started, so a server is not called silent before it has
 *  had the chance to ask. */
const STARTED_AT = Date.now();

/** How long a server may go without asking before the tab says it is not
 *  being moderated. It asks every thirty seconds. */
export const CHAT_SILENCE_MS = 3 * 60_000;

/** Reports one server may send in a minute: one per player every few seconds at
 *  most, so this is a whole server of players each flooding. */
export const CHAT_REPORTS_PER_MINUTE = 240;

const LOCALE: Readonly<Record<Language, Locale>> = { en: "en-US", es: "es-ES" };

function words(language: Language) {
    return gameCatalogs.translator(LOCALE[language], "minecraft");
}

/** A stop, in one language: why the line was not sent. */
function reasonLine(language: Language, reason: moderation.BlockReason): string {
    return words(language)(`moderation.game.${reason}`);
}

async function installOf(installedAppId: string) {
    return prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { ownerId: true, config: true, applicationId: true }
    });
}

async function serverLanguage(ownerId: string, config: Record<string, unknown>): Promise<Language> {
    return homeLanguage(ownerId, chosenLanguage(config));
}

/** One player's language: their linked account's, or the server's. */
async function playerLanguage(
    installedAppId: string,
    player: string,
    home: Language
): Promise<Language> {
    const link = await prisma.gamePlayerLink
        .findFirst({
            where: { installedAppId, player: { equals: player, mode: "insensitive" } },
            select: { userId: true }
        })
        .catch(() => null);
    return link ? accountLanguage(link.userId, home) : home;
}

/** The rules the server applies, and a note that it asked. */
export async function rulesForServer(
    installedAppId: string,
    version: string
): Promise<Record<string, unknown>> {
    heard.set(installedAppId, { at: Date.now(), version: version.slice(0, 80) });
    const row = await installOf(installedAppId);
    const config = readInstallConfig(row?.config);
    const rules = moderation.readChatModeration(config);
    const home = row ? await serverLanguage(row.ownerId, config) : "en";
    const fallback = Object.fromEntries(
        moderation.BLOCK_REASONS.map((reason) => [reason, reasonLine(home, reason)])
    ) as Record<moderation.BlockReason, string>;
    return moderation.rulesPayload(rules, fallback);
}

/** One stopped line as the server reports it, already validated by the route. */
export interface ReportedBlock {
    readonly player: string;
    readonly reason: moderation.BlockReason;
    readonly detail: string;
    readonly text: string;
    readonly command: boolean;
    readonly at: number;
}

/**
 * Keep a stopped line, decide what follows, and say what the player is told.
 * `limited` when the server is sending more than any real chat produces.
 */
export async function recordBlock(
    server: { readonly installedAppId: string; readonly ownerId: string },
    block: ReportedBlock
): Promise<{ warn: string; action: "warn" | "timeout" } | { limited: true }> {
    const { installedAppId, ownerId } = server;
    const allowed = await rateLimit(
        `minecraft-chat:${installedAppId}`,
        CHAT_REPORTS_PER_MINUTE,
        60_000
    ).catch(() => ({ ok: true }));
    if (!allowed.ok) return { limited: true };

    const row = await installOf(installedAppId);
    const config = readInstallConfig(row?.config);
    const rules = moderation.readChatModeration(config);
    const now = Date.now();
    const player = block.player.toLowerCase();
    // Strikes count from the last timeout on, so a player back from one starts
    // again rather than being removed on their first slip.
    const since = new Date(now - moderation.STRIKE_WINDOW_MS);
    const lastTimeout = await prisma.minecraftChatBlock.findFirst({
        where: { installedAppId, player, action: "timeout", at: { gte: since } },
        orderBy: { at: "desc" },
        select: { at: true }
    });
    const earlier = await prisma.minecraftChatBlock.count({
        where: { installedAppId, player, at: { gt: lastTimeout?.at ?? since } }
    });
    const next = moderation.consequence(rules, earlier + 1);
    await prisma.minecraftChatBlock.create({
        data: {
            installedAppId,
            player,
            playerName: block.player,
            reason: block.reason,
            detail: block.detail,
            text: block.text,
            command: block.command,
            action: next.action,
            // The server's clock is trusted only within a minute of Polaris's.
            at: new Date(Math.abs(block.at - now) <= 60_000 ? block.at : now)
        }
    });
    await prisma.minecraftChatBlock
        .deleteMany({ where: { installedAppId, at: { lt: new Date(now - moderation.LOG_KEEP_MS) } } })
        .catch(() => undefined);

    const home = await serverLanguage(ownerId, config);
    const language = await playerLanguage(installedAppId, block.player, home);
    const say = words(language);
    if (next.action === "timeout") {
        const reason = say("moderation.game.timeoutReason", { minutes: rules.timeoutMinutes });
        // Not awaited: the ban goes through the console, and the answer the
        // player is waiting on should not wait on it. A failure is logged; the
        // next stop tries again.
        void timeoutPlayer(ownerId, installedAppId, block.player, rules.timeoutMinutes, reason).catch(
            (caught) =>
                console.error(`[minecraft-chat] could not time out ${block.player} on ${installedAppId}:`, caught)
        );
        return { warn: reason, action: "timeout" };
    }
    const line = reasonLine(language, block.reason);
    return {
        warn: next.lastWarning
            ? `${line} ${say("moderation.game.lastWarning", { minutes: rules.timeoutMinutes })}`
            : line,
        action: "warn"
    };
}

/** One row of the tab's list. */
export interface ChatBlockEntry {
    readonly id: string;
    readonly player: string;
    readonly reason: string;
    readonly detail: string;
    readonly text: string;
    readonly command: boolean;
    readonly action: string;
    readonly at: string;
}

/** What the tab shows: the rules, what applies them, and what was stopped. */
export interface ChatModerationState {
    readonly rules: moderation.ChatModeration;
    /** What applies the rules on this server, or null when nothing does. */
    readonly carrier: ChatCarrier | null;
    /** Whether Polaris's anti-cheat, which carries moderation, can be switched
     *  on here in one click; when it cannot, nothing Polaris has runs here. */
    readonly canInstall: boolean;
    /** When the server last took its rules, if it has since this dashboard
     *  started, and whether it is too long ago to still be listening. */
    readonly seenAt: string | null;
    readonly silent: boolean;
    readonly log: readonly ChatBlockEntry[];
}

/** Rows listed on the tab. */
const LOG_ROWS = 100;

export async function chatModerationState(
    installedAppId: string,
    applicationId: string,
    ownerId: string
): Promise<ChatModerationState> {
    const [row, vars, rows] = await Promise.all([
        installOf(installedAppId),
        listEnvVars("application", applicationId, ownerId),
        prisma.minecraftChatBlock.findMany({
            where: { installedAppId },
            orderBy: { at: "desc" },
            take: LOG_ROWS
        })
    ]);
    const env = new Map(vars.map((entry) => [entry.key, entry.value ?? ""]));
    const build = anticheatBuildFor(env.get(SOFTWARE_KEY) ?? "", env.get("VERSION") ?? "");
    let carrier: ChatCarrier | null = null;
    if (build?.kind === "plugin" && anticheatOn(env)) carrier = "plugin";
    if (
        build?.kind === "mod" &&
        hasMod(env.get(MODS_KEY) ?? "") &&
        (env.get(URL_KEY) ?? "").length > 0 &&
        (anticheatOn(env) || loginOn(env))
    ) {
        carrier = "mod";
    }
    const seen = heard.get(installedAppId) ?? null;
    const now = Date.now();
    return {
        rules: moderation.readChatModeration(readInstallConfig(row?.config)),
        carrier,
        canInstall: carrier === null && build !== null,
        seenAt: seen ? new Date(seen.at).toISOString() : null,
        silent:
            carrier !== null &&
            now - STARTED_AT > CHAT_SILENCE_MS &&
            (!seen || now - seen.at > CHAT_SILENCE_MS),
        log: rows.map((entry) => ({
            id: entry.id,
            player: entry.playerName,
            reason: entry.reason,
            detail: entry.detail,
            text: entry.text,
            command: entry.command,
            action: entry.action,
            at: entry.at.toISOString()
        }))
    };
}

export async function saveChatModeration(
    installedAppId: string,
    rules: moderation.ChatModeration
): Promise<moderation.ChatModeration> {
    const tidy = moderation.tidy(rules);
    await patchInstallConfig(installedAppId, { [moderation.CHAT_MODERATION_KEY]: tidy });
    return tidy;
}
