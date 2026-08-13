"use server";

/**
 * What the Minecraft panel can do to a server. Reads live on the app's own API
 * route (they are polled); everything here changes something, so it is gated on
 * the game-server permissions - moderating players and running the console are
 * different grants - validates its input against the same schemas the form uses,
 * and is recorded: banning a player is an administrative act, not a UI event.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { clientIp } from "@/lib/request-context";
import { recordAudit } from "@/lib/audit-service";
import { setEnvVars } from "@/lib/env-var-service";
import { requirePermissionAny } from "@/lib/session";
import { runArkCommand } from "@/lib/apps/ark/service";
import { clearCrashLoop } from "@/lib/apps/games-health";
import { applyWorldSchedule } from "@/lib/backups/manage";
import { DIFFICULTIES } from "@/lib/apps/minecraft/rules";
import { findGameIdentity } from "@/lib/apps/game-identity";
import { isAddressRule } from "@/lib/apps/minecraft/access";
import { ITEM_ID_PATTERN } from "@/lib/apps/minecraft/items";
import { stripFormatting } from "@/lib/apps/minecraft/parse";
import type { PlayerStats } from "@/lib/apps/games-activity";
import { requireGameServer } from "@/lib/apps/install-access";
import { resetMinecraftServer } from "@/lib/apps/games-reset";
import { userSessionAddresses } from "@/lib/session-directory";
import type { QueuedAction } from "@/lib/apps/minecraft/queue";
import { patchInstallConfig } from "@/lib/apps/install-config";
import { MAX_TIMEOUT_MINUTES } from "@/lib/apps/player-timeout";
import { isMissingEntityReply } from "@/lib/apps/minecraft/snbt";
import { writeContainerFile } from "@/lib/container-files-service";
import type { InventoryItem } from "@/lib/apps/minecraft/inventory";
import { setGameSchedule } from "@/lib/apps/minecraft/schedule-service";
import { readMinecraftStats } from "@/lib/apps/minecraft/stats-service";
import { gameOfServer, routesByHostname } from "@/lib/apps/games-catalog";
import { setGameHostname, setGameRouted } from "@/lib/apps/minecraft/address";
import { deployApplication, setApplicationRunning } from "@/lib/deploy-service";
import { liftTimeout, timeoutPlayer } from "@/lib/apps/minecraft/timeout-service";
import { MAX_BACKUP_BYTES, MAX_KEEP_LAST } from "@/lib/apps/minecraft/backup-policy";
import { readPlayerRecord, type PlayerRecord } from "@/lib/apps/games-activity-service";
import { cancelAction, pendingFor, queueAction } from "@/lib/apps/minecraft/queue-service";
import { isBackupName, isBiome, isLevelName, isLevelType } from "@/lib/apps/minecraft/world";
import { parseDimension, parsePosition, type PlayerPosition } from "@/lib/apps/minecraft/position";
import { resetMinecraftServerSchema, type ResetMinecraftServerInput } from "@/lib/apps/games-schema";
import { MAX_IDLE_MINUTES, MIN_IDLE_MINUTES, type GameSchedule } from "@/lib/apps/minecraft/schedule";
import { readLiveInventory, readSnapshot, writeSnapshot } from "@/lib/apps/minecraft/inventory-service";
import { envFormatHint, findApp, isAllowedEnvValue, normalizeEnvValue, tunableEnvVars } from "@/lib/apps/catalog";
import { readRulesFor, setWorldDifficulty, setWorldRule, type WorldRules } from "@/lib/apps/minecraft/rules-service";
import {
    clearItem,
    clearSlot,
    giveItem,
    giveToSlot,
    moveStack,
    recentlyGivenItems
} from "@/lib/apps/minecraft/item-service";
import {
    applyFirewallBans,
    getServerPlayers,
    runConsoleLine,
    runServerCommand,
    withServerContainer
} from "@/lib/apps/minecraft/service";
import {
    grantPlayerAccess,
    listPlayerAccess,
    revokePlayerAccess,
    revokePlayerAddress,
    setAddressBinding,
    type PlayerAccessView
} from "@/lib/apps/minecraft/player-access";
import {
    createWorldBackup,
    deleteLevel,
    deleteWorldBackup,
    newWorld,
    restoreWorldBackup,
    setAsideVersionedConfig,
    setBackupPolicy,
    switchLevel
} from "@/lib/apps/minecraft/world-service";

/** A Minecraft (Java Edition) account name. */
const playerNameSchema = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{1,16}$/, "A player name is 1-16 letters, digits or underscores");

const moderationSchema = z.object({
    installedAppId: z.string().uuid(),
    action: z.enum(["op", "deop", "kick", "ban", "pardon", "kill", "whitelist-add", "whitelist-remove"]),
    player: playerNameSchema,
    /** Shown to the player being kicked or banned. */
    reason: z.string().trim().max(200).optional()
});

export type MinecraftModeration = z.infer<typeof moderationSchema>;

const consoleSchema = z.object({
    installedAppId: z.string().uuid(),
    line: z.string().trim().min(1).max(400)
});

const settingsSchema = z.object({
    installedAppId: z.string().uuid(),
    values: z.array(z.object({ key: z.string().trim().min(1).max(128), value: z.string().max(4096) })).max(64)
});

/** The command each moderation action sends, as argv. */
function moderationArgv(input: MinecraftModeration): string[] {
    const reason = input.reason && input.reason.length > 0 ? [input.reason] : [];
    switch (input.action) {
        case "op":
            return ["op", input.player];
        case "deop":
            return ["deop", input.player];
        case "kick":
            return ["kick", input.player, ...reason];
        case "ban":
            return ["ban", input.player, ...reason];
        case "pardon":
            return ["pardon", input.player];
        case "kill":
            return ["kill", input.player];
        case "whitelist-add":
            return ["whitelist", "add", input.player];
        case "whitelist-remove":
            return ["whitelist", "remove", input.player];
    }
}

export async function moderatePlayerAction(input: MinecraftModeration): Promise<{ output?: string; error?: string }> {
    const parsed = moderationSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { user, access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        const output = await runServerCommand(
            access.ownerId,
            parsed.data.installedAppId,
            moderationArgv(parsed.data)
        );
        await recordAudit({
            actorId: user.id,
            action: `minecraft.${parsed.data.action}`,
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { player: parsed.data.player }
        });
        return { output: output.trim() };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The server did not accept that" };
    }
}

/** A namespaced item id as the game writes it, with the namespace optional
 *  because `give Alice stone` is what an operator types. The pattern is the one
 *  the picker offers ids against, so the form cannot propose what this refuses. */
const itemIdSchema = z.string().trim().toLowerCase().regex(ITEM_ID_PATTERN, "An item looks like minecraft:stone");

/** Where to send somebody: another player, or three coordinates - each an
 *  absolute number or a `~` offset, which is how the game reads them. */
const destinationSchema = z.union([
    playerNameSchema,
    z
        .string()
        .trim()
        .regex(
            /^~?-?\d{1,7}(?:\.\d{1,3})?\s+~?-?\d{1,7}(?:\.\d{1,3})?\s+~?-?\d{1,7}(?:\.\d{1,3})?$/,
            "Coordinates look like 100 64 -220"
        )
]);

const giveSchema = z.object({
    installedAppId: z.string().uuid(),
    player: playerNameSchema,
    item: itemIdSchema,
    /** A total, not a stack. What arrives is stacks - 128 diamonds is two of
     *  them - and the ceiling is a bag's worth: 36 slots of 64 is everything a
     *  player can hold, and past that the rest is on the floor. */
    count: z.number().int().min(1).max(2304)
});

const teleportSchema = z.object({
    installedAppId: z.string().uuid(),
    player: playerNameSchema,
    destination: destinationSchema
});

const timeoutSchema = z.object({
    installedAppId: z.string().uuid(),
    player: playerNameSchema,
    minutes: z.number().int().min(1).max(MAX_TIMEOUT_MINUTES),
    reason: z.string().trim().max(200).optional()
});

export type GiveItemInput = z.infer<typeof giveSchema>;
export type TeleportInput = z.infer<typeof teleportSchema>;
export type TimeoutInput = z.infer<typeof timeoutSchema>;

/** Put items in a player's bag. */
export async function givePlayerItemAction(
    input: GiveItemInput
): Promise<{ output?: string; error?: string; queued?: true }> {
    const parsed = giveSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    const { installedAppId, player, item, count } = parsed.data;
    try {
        const { user, access } = await requireGameServer("games.moderate", installedAppId);
        // `/give` needs somebody standing there. Deciding at four in the afternoon
        // to hand something to a player who is asleep is the ordinary case, so it
        // is written down and happens when they next join - the same way putting
        // something in a particular slot already worked.
        if (!(await isOnline(access.ownerId, installedAppId, player))) {
            await queueAction({
                installedAppId,
                username: player,
                payload: { kind: "give", item, count },
                requestedById: user.id
            });
            return { queued: true };
        }
        const { given, output } = await giveItem(access.ownerId, installedAppId, player, item, count);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.give",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { player, item, count: given }
        });
        return { output: output.trim() };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The server did not accept that" };
    }
}

/** What was handed out on this server lately, for the palette to open on rather
 *  than on the whole catalogue. Empty is an answer: a server nobody has given
 *  anything on has no recent items, and the picker falls back to the full list. */
export async function recentItemsAction(installedAppId: string): Promise<{ items: string[] }> {
    const parsed = z.string().uuid().safeParse(installedAppId);
    if (!parsed.success) return { items: [] };
    try {
        await requireGameServer("games.read", parsed.data);
        return { items: await recentlyGivenItems(parsed.data) };
    } catch {
        return { items: [] };
    }
}

/** Move a player to another player, or to a place. */
export async function teleportPlayerAction(input: TeleportInput): Promise<{ output?: string; error?: string }> {
    const parsed = teleportSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    const { installedAppId, player, destination } = parsed.data;
    try {
        const { user, access } = await requireGameServer("games.moderate", installedAppId);
        // Split here rather than in the schema so coordinates reach the server as
        // three arguments and a player name as one, which is what `tp` expects.
        const output = await runServerCommand(access.ownerId, installedAppId, [
            "tp",
            player,
            ...destination.split(/\s+/)
        ]);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.teleport",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { player, destination }
        });
        return { output: output.trim() };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The server did not accept that" };
    }
}

/** What a bag reading is: live off the server, or the last copy Polaris kept. */
export interface InventoryReading {
    readonly items: InventoryItem[];
    /** True when the server was asked just now, false when this is the snapshot. */
    readonly live: boolean;
    /** When it was read, ISO 8601. On a live reading, now. Null when nothing was
     *  ever kept - an empty bag that is empty because nobody has looked, which
     *  is not the same as one that is empty because they are carrying nothing. */
    readonly takenAt: string | null;
    /** True when the bag was too big for one reply and had to be read a stack at a
     *  time. A round trip per stack, so what polls slows down rather than asking
     *  forty questions every two seconds. */
    readonly chunked?: boolean;
    /** Stacks the server named that could not be read whole. Shown rather than
     *  quietly missing from the grid. */
    readonly unreadable?: number;
}

/**
 * What a player is carrying.
 *
 * Live while they are on the server, and the last copy Polaris kept when they are
 * not - which is most of the time this gets asked. Which of the two it is comes
 * back with it, because a bag from twenty minutes ago looks exactly like one from
 * this second and only one of them can be changed.
 */
export async function readPlayerInventoryAction(
    installedAppId: string,
    player: string
): Promise<{ reading?: InventoryReading; error?: string }> {
    const parsed = z.object({ installedAppId: z.string().uuid(), player: playerNameSchema }).safeParse({
        installedAppId,
        player
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { access } = await requireGameServer("games.read", parsed.data.installedAppId);
        // One handshake for the whole read. A bag too big for a single RCON reply
        // is read a stack at a time, and forty of those through `runServerCommand`
        // would be forty connections to the machine.
        const reading = await withServerContainer(access.ownerId, parsed.data.installedAppId, (server) =>
            readLiveInventory(server.say, parsed.data.player)
        );
        // An empty bag and a reply that was never an inventory both read as no
        // items, and they are not the same thing to tell somebody checking what a
        // player is carrying. Only the server's own sentence proves it answered,
        // so without it the reader is shown what it actually said instead.
        if (!reading.answered) {
            // Not an answer. Whatever Polaris kept last is a better one than the
            // sentence the server printed instead, so it is offered before the
            // error is.
            const kept = await readSnapshot(parsed.data.installedAppId, parsed.data.player);
            if (kept) return { reading: { items: kept.items, live: false, takenAt: kept.takenAt } };
            // Offline is the ordinary case here, not a fault, and quoting the
            // server's "No entity was found" at somebody reads as one.
            if (isMissingEntityReply(reading.said)) {
                return {
                    error: "This player is not on the server, and Polaris has no copy of their bag yet. It keeps one every ten minutes while they are playing."
                };
            }
            const said = reading.said.trim().replace(/\s+/g, " ").slice(0, 160);
            // `/data` arrived in Java 1.13. Before that there is no command that
            // reads a player's bag at all, so quoting the parser error at somebody
            // is quoting a fact about their server version at them sideways.
            if (/unknown or incomplete command/i.test(said)) {
                return {
                    error: "This server does not have the /data command, so it cannot report what a player is carrying. Java 1.13 or newer can."
                };
            }
            return {
                error: said
                    ? `The server did not answer with an inventory: ${said}`
                    : "The server did not answer, and Polaris has no copy of this player's bag yet"
            };
        }
        // A live reading is also worth keeping: this is the one moment the bag is
        // known, and the next person to ask will be asking about somebody offline.
        await writeSnapshot(parsed.data.installedAppId, parsed.data.player, reading.items, new Date()).catch(
            () => undefined
        );
        return {
            reading: {
                items: reading.items,
                live: true,
                takenAt: new Date().toISOString(),
                ...(reading.chunked ? { chunked: true } : {}),
                ...(reading.unreadable > 0 ? { unreadable: reading.unreadable } : {})
            }
        };
    } catch (caught) {
        const kept = await readSnapshot(parsed.data.installedAppId, parsed.data.player).catch(() => null);
        if (kept) return { reading: { items: kept.items, live: false, takenAt: kept.takenAt } };
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : "Could not read the inventory, and Polaris has no copy of this player's bag yet"
        };
    }
}

/**
 * Where a player is standing, and in which world.
 *
 * Two reads, and the world is the optional one: a server that answers the
 * coordinates and not the dimension has still answered the question that was
 * asked, and refusing the whole thing over the label would be worse than showing
 * coordinates without it.
 */
export async function readPlayerPositionAction(
    installedAppId: string,
    player: string
): Promise<{ position?: PlayerPosition; error?: string }> {
    const parsed = z
        .object({ installedAppId: z.string().uuid(), player: playerNameSchema })
        .safeParse({ installedAppId, player });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { access } = await requireGameServer("games.read", parsed.data.installedAppId);
        const output = await runServerCommand(access.ownerId, parsed.data.installedAppId, [
            "data",
            "get",
            "entity",
            parsed.data.player,
            "Pos"
        ]);
        const coordinates = parsePosition(stripFormatting(output));
        if (coordinates === null) {
            return { error: "The server did not report a position - the player has to be on the server" };
        }
        const dimension = await runServerCommand(access.ownerId, parsed.data.installedAppId, [
            "data",
            "get",
            "entity",
            parsed.data.player,
            "Dimension"
        ]).then(
            (answer) => parseDimension(stripFormatting(answer)),
            () => null
        );
        return { position: { ...coordinates, dimension } };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : "Could not read the position - the player has to be on the server"
        };
    }
}

/**
 * Everything known about one player's time on this server.
 *
 * Two sources, and they answer different questions. Polaris's own record covers
 * every visit it has watched, with the times; the world's own statistics cover
 * everything the server has ever counted, including whatever happened before
 * Polaris was looking. Neither is a substitute for the other, and a missing one is
 * not an error - a young server has no statistics file yet, and a server Polaris
 * has only just met has no visits.
 */
export async function readPlayerRecordAction(
    installedAppId: string,
    player: string
): Promise<{ record?: PlayerRecord; stats?: PlayerStats | null; error?: string }> {
    const parsed = z
        .object({ installedAppId: z.string().uuid(), player: playerNameSchema })
        .safeParse({ installedAppId, player });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { access } = await requireGameServer("games.read", parsed.data.installedAppId);
        const [record, stats] = await Promise.all([
            readPlayerRecord(parsed.data.installedAppId, parsed.data.player),
            readMinecraftStats(access.ownerId, parsed.data.installedAppId, parsed.data.player)
        ]);
        return { record, stats };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not read this player's history" };
    }
}

/** Ban a player for a while, and let Polaris lift it. */
export async function timeoutPlayerAction(input: TimeoutInput): Promise<{ until?: string; error?: string }> {
    const parsed = timeoutSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    const { installedAppId, player, minutes, reason } = parsed.data;
    try {
        const { user, access } = await requireGameServer("games.moderate", installedAppId);
        const entry = await timeoutPlayer(access.ownerId, installedAppId, player, minutes, reason);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.timeout",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { player, minutes }
        });
        return { until: entry.until };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The server did not accept that" };
    }
}

/** End one early. */
export async function liftTimeoutAction(installedAppId: string, player: string): Promise<{ error?: string }> {
    const parsed = z.object({ installedAppId: z.string().uuid(), player: playerNameSchema }).safeParse({
        installedAppId,
        player
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { user, access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        await liftTimeout(access.ownerId, parsed.data.installedAppId, parsed.data.player);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.timeout-lift",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { player: parsed.data.player }
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not lift the timeout" };
    }
}

const scheduleWindowSchema = z.object({
    days: z.array(z.number().int().min(0).max(6)).max(7),
    from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time looks like 23:00"),
    to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time looks like 06:00"),
    mode: z.enum(["on", "off", "sleep"])
});

const scheduleSchema = z.object({
    installedAppId: z.string().uuid(),
    schedule: z.object({
        enabled: z.boolean(),
        /** Checked against the platform's own zone list rather than a pattern: a
         *  name that looks right and does not exist would silently be read as UTC,
         *  and the schedule would fire at the wrong hour with nothing to show for
         *  it. */
        timezone: z.string().min(1).max(64).refine(isKnownTimezone, "That is not a time zone this server knows"),
        otherwise: z.enum(["on", "off", "sleep"]),
        idleMinutes: z.number().int().min(MIN_IDLE_MINUTES).max(MAX_IDLE_MINUTES),
        windows: z.array(scheduleWindowSchema).max(24),
        // Bounded like the windows are, and for the same reason: this is written
        // into a settings blob that something later reads in a loop.
        routines: z
            .array(
                z.object({
                    id: z.string().min(1).max(64),
                    name: z.string().max(80),
                    enabled: z.boolean(),
                    days: z.array(z.number().int().min(0).max(6)).max(7),
                    at: z.string().regex(/^\d{2}:\d{2}$/, "A time like 04:00"),
                    actions: z
                        .array(
                            z.object({
                                kind: z.enum(["command", "broadcast", "restart", "backup"]),
                                value: z.string().max(400)
                            })
                        )
                        .min(1)
                        .max(8)
                })
            )
            .max(12)
    })
});

function isKnownTimezone(value: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

/** Declared rather than inferred: the schedule's own type is readonly all the
 *  way down, and the screen holds one of those. The schema still decides what is
 *  accepted; this only says what may be handed in. */
export interface GameScheduleInput {
    readonly installedAppId: string;
    readonly schedule: GameSchedule;
}

/** Save when a server should be up, and when it may go quiet. */
export async function saveGameScheduleAction(input: GameScheduleInput): Promise<{ error?: string }> {
    const parsed = scheduleSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        // The schedule is written straight to the install's config, so nothing else
        // on the way would refuse a server this person may not touch.
        const { user } = await requireGameServer("games.manage", parsed.data.installedAppId);
        await setGameSchedule(parsed.data.installedAppId, parsed.data.schedule);
        await recordAudit({
            actorId: user.id,
            action: "games.schedule",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { enabled: parsed.data.schedule.enabled, windows: parsed.data.schedule.windows.length }
        });
        revalidatePath(`/apps/installed/${parsed.data.installedAppId}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the schedule" };
    }
}

/** Turn the whitelist on or off. Separate from the roster: it decides whether the
 *  list is enforced at all, which is the switch an operator actually reaches for. */
export async function setWhitelistEnforcedAction(
    installedAppId: string,
    enforced: boolean
): Promise<{ output?: string; error?: string }> {
    try {
        const { access } = await requireGameServer("games.moderate", installedAppId);
        const output = await runServerCommand(access.ownerId, installedAppId, [
            "whitelist",
            enforced ? "on" : "off"
        ]);
        return { output: output.trim() };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change the whitelist" };
    }
}

const accessSchema = z.object({
    installedAppId: z.string().uuid(),
    username: z.string().trim().min(1).max(16),
    /** One address, a range, or "any". Re-checked in the service against the same
     *  rule the form uses. */
    address: z.string().trim().min(1).max(43),
    note: z.string().trim().max(120).optional()
});

export type PlayerAccessInput = z.infer<typeof accessSchema>;

/**
 * Let a player in, from an address. This is the pair the server is closed by, so
 * it is the full manage grant rather than the moderator one: moderating decides
 * who is thrown out today, this decides who can ever get in.
 */
export async function grantPlayerAccessAction(input: PlayerAccessInput): Promise<{ error?: string }> {
    const parsed = accessSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        await grantPlayerAccess(access.ownerId, parsed.data.installedAppId, user.id, {
            username: parsed.data.username,
            address: parsed.data.address,
            ...(parsed.data.note ? { note: parsed.data.note } : {})
        });
        await recordAudit({
            actorId: user.id,
            action: "minecraft.access-grant",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { player: parsed.data.username, address: parsed.data.address }
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not add that player" };
    }
}

/**
 * Who a Polaris name or address belongs to, and the Minecraft username they
 * linked.
 *
 * A server's player list is keyed by the username, and one wrong letter is
 * somebody who cannot join with nothing anywhere saying why - so the name is
 * taken from the account Mojang vouched for rather than retyped from a chat
 * message.
 *
 * Three answers, because the screen has three things to say: a name ready to add,
 * a person here who has linked nothing, and a name that is nobody.
 *
 * The addresses they are signed in from come back with it. The list needs one and
 * the operator filling it in is not on that person's line, so the choice is
 * between offering what the account already says and asking them over chat.
 */
export async function findMinecraftPlayerByUserAction(
    installedAppId: string,
    query: string
): Promise<{ username?: string; name?: string; addresses?: string[]; error?: string }> {
    const parsed = z.string().trim().min(1).max(120).safeParse(query);
    if (!parsed.success) return { error: "Type a Polaris username or email address" };
    try {
        await requireGameServer("games.manage", installedAppId);
        const found = await findGameIdentity(parsed.data, "minecraft");
        if (!found) return { error: "Nobody here goes by that. Check the username or the email address." };
        if (!found.identity) {
            return {
                error: `${found.name} has not linked a Minecraft account yet. They can do it under Connected accounts.`
            };
        }
        // Only the ones a rule can be written against. A session that arrived
        // over something this build cannot parse is not an address to offer.
        const addresses = (await userSessionAddresses(found.userId)).filter(isAddressRule);
        return { username: found.identity.label, name: found.name, addresses };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not look that up" };
    }
}

/** The list as it stands, for a screen that is not polling the server itself. */
export async function playerAccessAction(installedAppId: string): Promise<PlayerAccessView | null> {
    try {
        const { access } = await requireGameServer("games.read", installedAppId);
        return await listPlayerAccess(access.ownerId, installedAppId);
    } catch {
        return null;
    }
}

/**
 * The address Polaris sees this dashboard request arriving from.
 *
 * Offered as a fill for the address field, because the operator registering
 * themselves is almost always sitting on the line they will play from - and the
 * alternative is asking somebody to go and look their own IP up. It is only ever
 * a suggestion: the field stays editable, and what is typed is what is stored.
 */
export async function myAddressAction(): Promise<{ address: string | null }> {
    // Nothing about a particular server: it is the caller's own address, read for
    // the caller. Anybody who reaches a game server anywhere may ask.
    await requirePermissionAny("games.read");
    return { address: (await clientIp()) ?? null };
}

/** Take a player off the list, and off the server if they are on it. */
export async function revokePlayerAccessAction(
    installedAppId: string,
    username: string
): Promise<{ error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        await revokePlayerAccess(access.ownerId, installedAppId, username);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.access-revoke",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { player: username }
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not remove that player" };
    }
}

/** Take one address off a player, leaving whatever else they have. Removing the
 *  last one removes them, which the service decides so the two screens that call
 *  this cannot disagree about it. */
export async function revokePlayerAddressAction(
    installedAppId: string,
    username: string,
    address: string
): Promise<{ error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        await revokePlayerAddress(access.ownerId, installedAppId, username, address);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.access-revoke-address",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { player: username, address }
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not remove that address" };
    }
}

/**
 * Stop checking where a player connects from, or start again.
 *
 * Off is a real loosening - a leaked account is then enough to get in - so it is
 * recorded like any other change to who can reach the server.
 */
export async function setAddressBindingAction(
    installedAppId: string,
    enabled: boolean
): Promise<{ error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        await setAddressBinding(access.ownerId, installedAppId, enabled);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.access-binding",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { enabled }
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change that" };
    }
}

/**
 * Move a server onto a different name.
 *
 * The records are written for the operator (an A record at this machine, and for
 * Java a SRV record so the port is not part of what a player types), which is why
 * this is the manage grant: it changes what the world can reach.
 */
export async function setGameHostnameAction(
    installedAppId: string,
    subdomain: string
): Promise<{ hostname?: string | null; error?: string }> {
    const parsed = z.string().trim().max(63).safeParse(subdomain);
    if (!parsed.success) return { error: "That subdomain is too long" };
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        const install = access.install;
        // Which game it is decides both halves of the name: the label its servers
        // live under, and whether a client will look the port up for itself.
        const game = gameOfServer(install.catalogId);
        const hostname = await setGameHostname(access.ownerId, installedAppId, {
            name: install.name,
            ...(parsed.data ? { subdomain: parsed.data } : {}),
            srv: routesByHostname(install.catalogId),
            ...(game ? { gameLabel: game.domainLabel } : {})
        });
        await recordAudit({
            actorId: user.id,
            action: "minecraft.hostname",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { hostname }
        });
        revalidatePath(`/apps/installed/${installedAppId}`);
        return { hostname };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not set that address" };
    }
}

/**
 * Put a Java server behind the shared port, or take it back off.
 *
 * The manage grant for the same reason as the name itself: it decides what a player
 * types and what the world can reach. The refusals - a game that carries no hostname
 * to route on, a player list bound to addresses - live with the change rather than
 * here, so the same rules apply however this is called.
 */
export async function setGameRoutedAction(
    installedAppId: string,
    routed: boolean
): Promise<{ ok?: true; error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        await setGameRouted(access.ownerId, installedAppId, routed);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.routed",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { routed }
        });
        revalidatePath(`/apps/installed/${installedAppId}`);
        return { ok: true };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change that" };
    }
}

/**
 * Rename a server.
 *
 * Only what Polaris calls it. The address is deliberately left alone: it was
 * derived from the name when the server was created, players have it written down,
 * and silently moving a server because somebody fixed a typo would be worse than
 * the two names disagreeing. Changing the address is its own control, next to this.
 */
export async function renameGameServerAction(
    installedAppId: string,
    name: string
): Promise<{ name?: string; error?: string }> {
    const parsed = z.string().trim().min(1, "Give the server a name").max(60).safeParse(name);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That name will not do" };
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        const install = access.install;
        await prisma.installedApp.update({ where: { id: install.id }, data: { name: parsed.data } });
        await recordAudit({
            actorId: user.id,
            action: "games.rename",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { from: install.name, to: parsed.data }
        });
        revalidatePath(`/apps/installed/${installedAppId}`);
        revalidatePath("/apps/games");
        return { name: parsed.data };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not rename the server" };
    }
}

/** Where the image looks for the picture shown beside the server in the client's
 *  multiplayer list. */
const ICON_PATH = "/data/server-icon.png";

/** Minecraft's own rule: exactly this, in pixels, or it is ignored. */
const ICON_SIDE = 64;

/** A 64x64 PNG is a couple of kilobytes. This is loose enough never to reject a
 *  real one and tight enough that nothing large is pushed into a container. */
const MAX_ICON_BYTES = 512 * 1024;

const iconSchema = z.object({
    installedAppId: z.string().uuid(),
    /** The PNG, base64 encoded, already scaled to 64x64 by the browser. */
    png: z.string().min(1).max(Math.ceil((MAX_ICON_BYTES * 4) / 3) + 64)
});

/**
 * The picture beside the server in the multiplayer list.
 *
 * The browser scales whatever was picked to 64x64 before sending it, because that
 * is the only size Minecraft accepts and asking somebody to go and resize a file
 * themselves is not a feature. That makes the client the convenient path and not
 * the authority: the bytes are checked here for being a PNG of exactly that size,
 * since anything else is silently ignored by the server and would look like Polaris
 * had lost the upload.
 */
export async function setServerIconAction(input: {
    installedAppId: string;
    png: string;
}): Promise<{ error?: string }> {
    const parsed = iconSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That image will not do" };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        const bytes = Buffer.from(parsed.data.png, "base64");
        if (bytes.length === 0) throw new Error("That image is empty");
        if (bytes.length > MAX_ICON_BYTES) throw new Error("That image is too large");
        const size = pngSize(bytes);
        if (!size) throw new Error("That is not a PNG");
        if (size.width !== ICON_SIDE || size.height !== ICON_SIDE) {
            throw new Error(`A server icon has to be ${ICON_SIDE}x${ICON_SIDE}`);
        }

        if (!access.install.applicationId) throw new Error("This server has not been deployed yet");
        await writeContainerFile(access.install.applicationId, access.ownerId, ICON_PATH, bytes);
        // What the panel shows without reaching into the container for it.
        await patchInstallConfig(parsed.data.installedAppId, { iconSetAt: new Date().toISOString() });
        await recordAudit({
            actorId: user.id,
            action: "games.icon",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId
        });
        revalidatePath(`/apps/installed/${parsed.data.installedAppId}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not set the icon" };
    }
}

/**
 * A PNG's dimensions, from its header.
 *
 * The signature and then IHDR, which the format requires to be the first chunk, so
 * the width and height sit at a fixed offset. Enough to refuse the wrong size
 * without a decoder, and the only thing that has to be known about the file.
 */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)) return null;
    if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Hand the firewall's blocked addresses to the server's own ban list. */
export async function applyFirewallBansAction(installedAppId: string): Promise<{ banned?: number; error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.moderate", installedAppId);
        const banned = await applyFirewallBans(access.ownerId, installedAppId);
        if (banned > 0) {
            await recordAudit({
                actorId: user.id,
                action: "minecraft.firewall-apply",
                targetType: "installedApp",
                targetId: installedAppId,
                metadata: { banned }
            });
        }
        return { banned };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not apply the firewall" };
    }
}

/** Flush the world to disk, for before a backup or a restart. */
export async function saveWorldAction(installedAppId: string): Promise<{ output?: string; error?: string }> {
    try {
        const { access } = await requireGameServer("games.moderate", installedAppId);
        const output = await runServerCommand(access.ownerId, installedAppId, ["save-all"]);
        return { output: output.trim() };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the world" };
    }
}

/**
 * The map, and the copies of it.
 *
 * All of these are the manage grant rather than the moderator one, backing up
 * included: every one of them writes into the world volume, and a restore or a
 * new world decides which map the server comes back on. Each is recorded for the
 * same reason - replacing the map is the least reversible thing this panel can
 * do to a server people have built on.
 */

const worldNameSchema = z.object({
    installedAppId: z.string().uuid(),
    /** A level as it is named on disk. Re-checked in the service against the same
     *  rule, since this decides a path inside the container. */
    level: z.string().trim().min(1).max(64).refine(isLevelName, "That is not a world on this server")
});

const backupNameSchema = z.object({
    installedAppId: z.string().uuid(),
    name: z.string().trim().min(1).max(64).refine(isBackupName, "That is not a backup of this server")
});

const newWorldSchema = z.object({
    installedAppId: z.string().uuid(),
    /** Blank generates a random world. */
    seed: z.string().trim().max(64).optional(),
    /** The shape of the world. Java only; Bedrock names its own differently. */
    levelType: z.string().trim().max(64).refine(isLevelType, "That is not a world type").optional(),
    /** Which biome the whole overworld is, when the type is the one-biome one. */
    biome: z.string().trim().max(64).refine(isBiome, "That is not a biome").optional(),
    /** Java only: carry every player's bag, stats and advancements across. */
    keepPlayers: z.boolean().default(false)
});

export type NewWorldInput = z.infer<typeof newWorldSchema>;

/** Copy the world into an archive on the server. */
export async function backUpWorldAction(installedAppId: string): Promise<{ name?: string; error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        const backup = await createWorldBackup(access.ownerId, installedAppId);
        await recordAudit({
            actorId: user.id,
            action: "games.world-backup",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { name: backup.name, bytes: backup.sizeBytes }
        });
        return { name: backup.name };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not back up the world" };
    }
}

const backupPolicySchema = z.object({
    installedAppId: z.string().uuid(),
    every: z.enum(["off", "hourly", "six-hourly", "daily", "weekly"]),
    /** 0 means no count limit. */
    keepLast: z.number().int().min(0).max(MAX_KEEP_LAST),
    /** 0 means no size limit. */
    maxBytes: z.number().int().min(0).max(MAX_BACKUP_BYTES),
    notifyOnFailure: z.boolean()
});

export type BackupPolicyInput = z.infer<typeof backupPolicySchema>;

/** How often this server's world is copied, and how much of it is kept. */
export async function saveBackupPolicyAction(input: BackupPolicyInput): Promise<{ error?: string }> {
    const parsed = backupPolicySchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    const { installedAppId, ...rules } = parsed.data;
    try {
        // The policy is written straight to the install's config, so nothing else
        // on the way would refuse a server this person may not touch.
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        await setBackupPolicy(installedAppId, rules);
        // Write it through to the backup engine as well. The sweep that actually
        // takes these copies reads plans now, so a schedule saved only into this
        // app's config would be a control that looks like it works and does
        // nothing. Both screens end up describing the same plan.
        await applyWorldSchedule(access.install.ownerId, installedAppId, access.install.name, rules).catch(() => undefined);
        await recordAudit({
            actorId: user.id,
            action: "games.backup-policy",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { every: rules.every, keepLast: rules.keepLast, maxBytes: rules.maxBytes }
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the backup schedule" };
    }
}

/** Take an archive off the server. */
export async function deleteWorldBackupAction(installedAppId: string, name: string): Promise<{ error?: string }> {
    const parsed = backupNameSchema.safeParse({ installedAppId, name });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That is not a backup of this server" };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        await deleteWorldBackup(access.ownerId, parsed.data.installedAppId, parsed.data.name);
        await recordAudit({
            actorId: user.id,
            action: "games.world-backup-delete",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { name: parsed.data.name }
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not delete the backup" };
    }
}

/** Put an archived world back and restart onto it. The map it was on stays. */
export async function restoreWorldBackupAction(
    installedAppId: string,
    name: string
): Promise<{ level?: string; error?: string }> {
    const parsed = backupNameSchema.safeParse({ installedAppId, name });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That is not a backup of this server" };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        const restored = await restoreWorldBackup(
            access.ownerId,
            parsed.data.installedAppId,
            parsed.data.name,
            user.id
        );
        await recordAudit({
            actorId: user.id,
            action: "games.world-restore",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { name: parsed.data.name, level: restored.level }
        });
        revalidatePath(`/apps/installed/${parsed.data.installedAppId}`);
        return { level: restored.level };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not restore that backup" };
    }
}

/**
 * Put the settings on disk out of the way and start the server again.
 *
 * The way out of the one crash Polaris can name. Settings written by a newer
 * Minecraft than the server now runs cannot be read by it, and it dies while
 * loading them - so there is nothing to fix in the game, only a folder to move,
 * and the server writes its own again on the next boot. Offered on the banner
 * that names the crash rather than buried under settings, because the person
 * reading that banner is the person who needs it.
 *
 * Nothing is deleted. What moves lands in a folder beside the world, so an
 * operator who had tuned something has it.
 */
export async function resetServerConfigAction(installedAppId: string): Promise<{ moved?: boolean; error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        if (!access.install.applicationId) throw new Error("This server has not been deployed yet");
        const aside = await setAsideVersionedConfig(access.ownerId, installedAppId);
        // Cleared before the start, or the server comes up under a banner saying
        // it is stopped for a crash it is currently being given a chance to avoid.
        // If it crashes anyway the health sweep writes it back within the minute.
        await clearCrashLoop(installedAppId);
        await setApplicationRunning(access.install.applicationId, access.ownerId, true);
        await recordAudit({
            actorId: user.id,
            action: "games.config-reset",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { movedTo: aside }
        });
        revalidatePath(`/apps/installed/${installedAppId}`);
        return { moved: aside !== null };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not reset the server's settings" };
    }
}

/** Generate a new map, optionally carrying what every player is holding. */
export async function newWorldAction(input: NewWorldInput): Promise<{ level?: string; carried?: boolean; error?: string }> {
    const parsed = newWorldSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        const created = await newWorld(
            access.ownerId,
            parsed.data.installedAppId,
            {
                ...(parsed.data.seed ? { seed: parsed.data.seed } : {}),
                ...(parsed.data.levelType ? { levelType: parsed.data.levelType } : {}),
                ...(parsed.data.biome ? { biome: parsed.data.biome } : {}),
                keepPlayers: parsed.data.keepPlayers
            },
            user.id
        );
        await recordAudit({
            actorId: user.id,
            action: "games.world-new",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { level: created.level, seeded: Boolean(parsed.data.seed), keptPlayers: created.carried }
        });
        revalidatePath(`/apps/installed/${parsed.data.installedAppId}`);
        return { level: created.level, carried: created.carried };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not start a new world" };
    }
}

/**
 * Rebuild this server as a blueprint, on a fresh map.
 *
 * The heaviest thing on the Settings screen and the one that most looks like a
 * delete, so it is recorded with what it was turned into. It is not a delete: the
 * address, the player list, the grants other people hold on it and the map it was
 * on are all still there afterwards - see games-reset for why each of those is
 * deliberately untouched.
 */
export async function resetGameServerAction(
    input: ResetMinecraftServerInput
): Promise<{ level?: string; version?: string; carried?: boolean; error?: string }> {
    const parsed = resetMinecraftServerSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        const { installedAppId, ...shape } = parsed.data;
        const done = await resetMinecraftServer(access.ownerId, installedAppId, user.id, shape);
        await recordAudit({
            actorId: user.id,
            action: "games.reset",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: {
                blueprint: shape.blueprintId,
                map: shape.mapId ?? null,
                version: done.version,
                level: done.level,
                keptPlayers: done.carried,
                configReset: done.configReset
            }
        });
        revalidatePath(`/apps/installed/${installedAppId}`);
        return { level: done.level, version: done.version, carried: done.carried };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not reset the server" };
    }
}

/** Boot the server onto a map it already has. */
export async function switchWorldAction(installedAppId: string, level: string): Promise<{ error?: string }> {
    const parsed = worldNameSchema.safeParse({ installedAppId, level });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That is not a world on this server" };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        await switchLevel(access.ownerId, parsed.data.installedAppId, parsed.data.level, user.id);
        await recordAudit({
            actorId: user.id,
            action: "games.world-switch",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { level: parsed.data.level }
        });
        revalidatePath(`/apps/installed/${parsed.data.installedAppId}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not switch world" };
    }
}

/** Delete a map the server is not on. */
export async function deleteWorldAction(installedAppId: string, level: string): Promise<{ error?: string }> {
    const parsed = worldNameSchema.safeParse({ installedAppId, level });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That is not a world on this server" };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        await deleteLevel(access.ownerId, parsed.data.installedAppId, parsed.data.level);
        await recordAudit({
            actorId: user.id,
            action: "games.world-delete",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { level: parsed.data.level }
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not delete that world" };
    }
}

/** A line typed in the console, sent as the console would send it. */
export async function sendConsoleCommandAction(
    installedAppId: string,
    line: string
): Promise<{ output?: string; error?: string }> {
    const parsed = consoleSchema.safeParse({ installedAppId, line });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That command is not valid" };
    try {
        // The console runs any command the server takes, op included, so it is the
        // full grant rather than the moderator one.
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        // Recorded before it runs, and recorded whatever it does.
        //
        // Every other thing this screen can do to a server leaves a line in the
        // audit - who opped whom, who banned whom, who changed the world. The
        // console is how you do all of those without going through any of them,
        // and it was the one action that left nothing at all. A server where the
        // deliberate route is written down and the general-purpose one is not is a
        // server with no record of anything that mattered.
        await recordAudit({
            actorId: user.id,
            action: "games.console",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { line: parsed.data.line }
        });
        // One console, two languages underneath. Which one is decided here rather
        // than by the screen: the panel that renders the console is the same one.
        const output =
            gameOfServer(access.install.catalogId)?.id === "ark"
                ? await runArkCommand(access.ownerId, parsed.data.installedAppId, parsed.data.line.replace(/^\//, ""))
                : await runConsoleLine(access.ownerId, parsed.data.installedAppId, parsed.data.line);
        return { output: output.trim() };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The server did not accept that command" };
    }
}

/**
 * Save the server's settings and restart it onto them. The image writes
 * server.properties from its environment at boot, so a setting is not a live
 * value to poke at - it is the container's environment, and applying it is a
 * redeploy. Which is why this says so on the button rather than pretending the
 * change is instant.
 */
/**
 * Save settings, and optionally restart so they take effect now.
 *
 * The image writes server.properties from its environment at boot, so nothing
 * here reaches a running server: a value saved without a restart is a value the
 * server picks up the next time it starts, whenever that is. That is worth having
 * on its own - somebody writing a description at four in the afternoon should not
 * have to choose between losing it and disconnecting everybody who is playing.
 */
export async function updateServerSettingsAction(
    installedAppId: string,
    values: Array<{ key: string; value: string }>,
    /** False stores the values and leaves the running server alone. */
    restart = true
): Promise<{ error?: string }> {
    const parsed = settingsSchema.safeParse({ installedAppId, values });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the settings and try again" };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        const install = access.install;
        if (!install.applicationId) throw new Error("This server has not been deployed yet");
        const manifest = findApp(install.catalogId);
        if (!manifest) throw new Error("Unknown app");

        // Only what the manifest declares as tunable, only values it allows: the
        // form is a view of this list, not the authority on it.
        const tunables = tunableEnvVars(manifest);
        const vars = parsed.data.values.flatMap((entry) => {
            const field = tunables.find((item) => item.key === entry.key);
            if (!field) return [];
            const value = normalizeEnvValue(field, entry.value);
            // A declared field whose value does not fit is said out loud rather
            // than dropped. Dropping it is how a setting looks saved, is not, and
            // the server it feeds restarts forever on the old value.
            if (!isAllowedEnvValue(field, value)) throw new Error(`${field.label}: ${envFormatHint(field)}`);
            return [{ key: entry.key, value, isSecret: Boolean(field.secret) }];
        });
        if (vars.length === 0) throw new Error("Nothing to save");
        await setEnvVars("application", install.applicationId, access.ownerId, vars);
        if (restart) await deployApplication(install.applicationId, access.ownerId, user.id);
        revalidatePath(`/apps/installed/${parsed.data.installedAppId}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the settings" };
    }
}
/**
 * What the world is being played under.
 *
 * A read, so it is `games.read`: an operator who may look at a server may see
 * whether deaths cost people their inventory. Changing one is `games.manage`
 * below.
 */
export async function readWorldRulesAction(
    installedAppId: string
): Promise<{ rules?: WorldRules; error?: string }> {
    const parsed = z.string().uuid().safeParse(installedAppId);
    if (!parsed.success) return { error: "That server does not exist" };
    try {
        const { access } = await requireGameServer("games.read", parsed.data);
        return { rules: await readRulesFor(access.ownerId, parsed.data) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not read the rules" };
    }
}

/**
 * Change one rule while the server keeps running.
 *
 * Deliberately not a form with a Save button: every rule here takes effect the
 * instant the server is told, so a screen that batched them would be inventing a
 * pending state the game does not have. The value that comes back is the server's
 * own, which is what the screen then shows.
 */
export async function setWorldRuleAction(
    installedAppId: string,
    rule: string,
    value: string
): Promise<{ value?: string; error?: string }> {
    const parsed = z
        .object({
            installedAppId: z.string().uuid(),
            rule: z.string().trim().min(1).max(64),
            value: z.string().trim().min(1).max(16)
        })
        .safeParse({ installedAppId, rule, value });
    if (!parsed.success) return { error: "Check the value and try again" };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        const applied = await setWorldRule(
            access.ownerId,
            parsed.data.installedAppId,
            parsed.data.rule,
            parsed.data.value
        );
        await recordAudit({
            actorId: user.id,
            action: "minecraft.gamerule",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { rule: parsed.data.rule, value: applied }
        });
        return { value: applied };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change that rule" };
    }
}

/** The difficulty, live. `server.properties` carries one too, and changing that
 *  one rebuilds the container - this does not. */
export async function setWorldDifficultyAction(
    installedAppId: string,
    difficulty: string
): Promise<{ error?: string }> {
    const parsed = z
        .object({ installedAppId: z.string().uuid(), difficulty: z.enum(DIFFICULTIES) })
        .safeParse({ installedAppId, difficulty });
    if (!parsed.success) return { error: "That is not a difficulty" };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        await setWorldDifficulty(access.ownerId, parsed.data.installedAppId, parsed.data.difficulty);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.difficulty",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { difficulty: parsed.data.difficulty }
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change the difficulty" };
    }
}

/** One stack as a screen holds it, for a write that says what it believed. */
const stackSchema = z.object({
    slot: z.number().int().min(-128).max(127),
    id: z.string().trim().min(1).max(128),
    count: z.number().int().min(1).max(127),
    data: z
        .object({ era: z.enum(["components", "tag"]), snbt: z.string().min(2).max(4096) })
        .nullable()
        .default(null)
});

const moveSchema = z.object({
    installedAppId: z.string().uuid(),
    player: playerNameSchema,
    from: z.number().int().min(-128).max(127),
    to: z.number().int().min(-128).max(127),
    /** What the screen was showing in each of the two slots. The server compares
     *  before it writes, so a stale dialog refuses instead of destroying. */
    expected: z.object({ from: stackSchema.nullable(), to: stackSchema.nullable() }),
    /** Fewer than the stack holds splits it, which needs an empty target. */
    count: z.number().int().min(1).max(127).optional()
});

export type MoveSlotInput = z.infer<typeof moveSchema>;

/** Move a stack from one slot to another, swapping with what is in the way. */
export async function moveInventorySlotAction(input: MoveSlotInput): Promise<{ error?: string; }> {
    const parsed = moveSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { user, access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        await moveStack(
            access.ownerId,
            parsed.data.installedAppId,
            parsed.data.player,
            parsed.data.from,
            parsed.data.to,
            parsed.data.expected,
            parsed.data.count
        );
        await recordAudit({
            actorId: user.id,
            action: "minecraft.inventory-move",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { player: parsed.data.player, from: parsed.data.from, to: parsed.data.to }
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not move that stack" };
    }
}

const slotItemSchema = z.object({
    installedAppId: z.string().uuid(),
    player: playerNameSchema,
    slot: z.number().int().min(-128).max(127),
    item: itemIdSchema,
    count: z.number().int().min(1).max(64)
});

export type SlotItemInput = z.infer<typeof slotItemSchema>;

/** Whether this player is standing on the server right now. */
async function isOnline(ownerId: string, installedAppId: string, player: string): Promise<boolean> {
    const status = await getServerPlayers(ownerId, installedAppId).catch(() => null);
    return status?.players.players.some((name) => name.toLowerCase() === player.toLowerCase()) === true;
}

/**
 * Put an item in a slot.
 *
 * Queued instead when the player is not on: the command needs them present, and
 * an operator deciding at four in the afternoon should not have to come back and
 * remember it.
 */
export async function setInventorySlotAction(input: SlotItemInput): Promise<{ queued?: true; error?: string; }> {
    const parsed = slotItemSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    const { installedAppId, player, slot, item, count } = parsed.data;
    try {
        const { user, access } = await requireGameServer("games.moderate", installedAppId);
        if (!(await isOnline(access.ownerId, installedAppId, player))) {
            await queueAction({
                installedAppId,
                username: player,
                payload: { kind: "set-slot", slot, item, count },
                requestedById: user.id
            });
            return { queued: true };
        }
        await giveToSlot(access.ownerId, installedAppId, player, slot, item, count);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.inventory-set",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { player, slot, item, count }
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not put that in the slot" };
    }
}

/** Empty one slot. */
export async function clearInventorySlotAction(
    installedAppId: string,
    player: string,
    slot: number
): Promise<{ error?: string; }> {
    const parsed = z
        .object({ installedAppId: z.string().uuid(), player: playerNameSchema, slot: z.number().int() })
        .safeParse({ installedAppId, player, slot });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { user, access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        await clearSlot(access.ownerId, parsed.data.installedAppId, parsed.data.player, parsed.data.slot);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.inventory-clear",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { player: parsed.data.player, slot: parsed.data.slot }
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not empty that slot" };
    }
}

const takeSchema = z.object({
    installedAppId: z.string().uuid(),
    player: playerNameSchema,
    item: itemIdSchema,
    /** A total, not a stack, and the same ceiling giving has: taking back what was
     *  just handed over is the commonest reason to reach for this, so a lower
     *  limit here would refuse the mirror of an amount the panel accepted. */
    count: z.number().int().min(1).max(2304)
});

/** Take a number of one item away, wherever it is in the bag. Queued when the
 *  player is not on. */
export async function clearPlayerItemAction(
    input: z.infer<typeof takeSchema>
): Promise<{ queued?: true; output?: string; error?: string; }> {
    const parsed = takeSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    const { installedAppId, player, item, count } = parsed.data;
    try {
        const { user, access } = await requireGameServer("games.moderate", installedAppId);
        if (!(await isOnline(access.ownerId, installedAppId, player))) {
            await queueAction({
                installedAppId,
                username: player,
                payload: { kind: "clear", item, count },
                requestedById: user.id
            });
            return { queued: true };
        }
        const output = await clearItem(access.ownerId, installedAppId, player, item, count);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.inventory-take",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { player, item, count }
        });
        return { output: output.trim() };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not take that away" };
    }
}

/** What is still waiting on this server, for the screen that shows it. */
export async function pendingActionsAction(installedAppId: string): Promise<{ pending: QueuedAction[]; }> {
    try {
        await requireGameServer("games.read", installedAppId);
        return { pending: await pendingFor(installedAppId) };
    } catch {
        return { pending: [] };
    }
}

/** Change your mind about something that was waiting. */
export async function cancelQueuedActionAction(installedAppId: string, id: string): Promise<{ error?: string; }> {
    const parsed = z
        .object({ installedAppId: z.string().uuid(), id: z.string().uuid() })
        .safeParse({ installedAppId, id });
    if (!parsed.success) return { error: "That is not a waiting action on this server" };
    try {
        const { user } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        await cancelAction(parsed.data.installedAppId, parsed.data.id);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.queued-cancel",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { queued: parsed.data.id }
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not cancel that" };
    }
}
