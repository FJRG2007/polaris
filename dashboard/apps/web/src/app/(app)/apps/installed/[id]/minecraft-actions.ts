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
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { setEnvVars } from "@/lib/env-var-service";
import { isDataReply } from "@/lib/apps/minecraft/snbt";
import { deployApplication } from "@/lib/deploy-service";
import { getInstalledApp } from "@/lib/apps/install-service";
import { ITEM_ID_PATTERN } from "@/lib/apps/minecraft/items";
import { stripFormatting } from "@/lib/apps/minecraft/parse";
import { setGameHostname } from "@/lib/apps/minecraft/address";
import { patchInstallConfig } from "@/lib/apps/install-config";
import { writeContainerFile } from "@/lib/container-files-service";
import { MAX_TIMEOUT_MINUTES } from "@/lib/apps/minecraft/timeout";
import { setGameSchedule } from "@/lib/apps/minecraft/schedule-service";
import { findApp, isAllowedEnvValue, tunableEnvVars } from "@/lib/apps/catalog";
import { liftTimeout, timeoutPlayer } from "@/lib/apps/minecraft/timeout-service";
import { parseInventory, type InventoryItem } from "@/lib/apps/minecraft/inventory";
import { isBackupName, isBiome, isLevelName, isLevelType } from "@/lib/apps/minecraft/world";
import { parseDimension, parsePosition, type PlayerPosition } from "@/lib/apps/minecraft/position";
import { applyFirewallBans, runConsoleLine, runServerCommand } from "@/lib/apps/minecraft/service";
import { MAX_IDLE_MINUTES, MIN_IDLE_MINUTES, type GameSchedule } from "@/lib/apps/minecraft/schedule";
import {
    createWorldBackup,
    deleteLevel,
    deleteWorldBackup,
    newWorld,
    restoreWorldBackup,
    switchLevel
} from "@/lib/apps/minecraft/world-service";
import {
    grantPlayerAccess,
    listPlayerAccess,
    revokePlayerAccess,
    setAddressBinding,
    type PlayerAccessView
} from "@/lib/apps/minecraft/player-access";

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
    const user = await requirePermission("games.moderate");
    const parsed = moderationSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const output = await runServerCommand(user.id, parsed.data.installedAppId, moderationArgv(parsed.data));
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
    /** One stack at a time; more than that is several presses, which is the
     *  honest amount of deliberation for handing out items. */
    count: z.number().int().min(1).max(64)
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
export async function givePlayerItemAction(input: GiveItemInput): Promise<{ output?: string; error?: string }> {
    const user = await requirePermission("games.moderate");
    const parsed = giveSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    const { installedAppId, player, item, count } = parsed.data;
    try {
        const output = await runServerCommand(user.id, installedAppId, ["give", player, item, String(count)]);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.give",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { player, item, count }
        });
        return { output: output.trim() };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The server did not accept that" };
    }
}

/** Move a player to another player, or to a place. */
export async function teleportPlayerAction(input: TeleportInput): Promise<{ output?: string; error?: string }> {
    const user = await requirePermission("games.moderate");
    const parsed = teleportSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    const { installedAppId, player, destination } = parsed.data;
    try {
        // Split here rather than in the schema so coordinates reach the server as
        // three arguments and a player name as one, which is what `tp` expects.
        const output = await runServerCommand(user.id, installedAppId, [
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

/** What a player is carrying, read out of the server rather than guessed from
 *  what anyone has handed them. */
export async function readPlayerInventoryAction(
    installedAppId: string,
    player: string
): Promise<{ items?: InventoryItem[]; error?: string }> {
    const user = await requirePermission("games.read");
    const parsed = z.object({ installedAppId: z.string().uuid(), player: playerNameSchema }).safeParse({
        installedAppId,
        player
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const output = await runServerCommand(user.id, parsed.data.installedAppId, [
            "data",
            "get",
            "entity",
            parsed.data.player,
            "Inventory"
        ]);
        const text = stripFormatting(output);
        const items = parseInventory(text);
        // An empty bag and a reply that was never an inventory both read as no
        // items, and they are not the same thing to tell somebody checking what a
        // player is carrying. Only the server's own sentence proves it answered,
        // so without it the reader is shown what it actually said instead.
        if (items.length === 0 && !isDataReply(text)) {
            const said = text.trim().replace(/\s+/g, " ").slice(0, 160);
            return {
                error: said
                    ? `The server did not answer with an inventory: ${said}`
                    : "The server did not answer - the player has to be on the server"
            };
        }
        return { items };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : "Could not read the inventory - the player has to be on the server"
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
    const user = await requirePermission("games.read");
    const parsed = z
        .object({ installedAppId: z.string().uuid(), player: playerNameSchema })
        .safeParse({ installedAppId, player });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const output = await runServerCommand(user.id, parsed.data.installedAppId, [
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
        const dimension = await runServerCommand(user.id, parsed.data.installedAppId, [
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

/** Ban a player for a while, and let Polaris lift it. */
export async function timeoutPlayerAction(input: TimeoutInput): Promise<{ until?: string; error?: string }> {
    const user = await requirePermission("games.moderate");
    const parsed = timeoutSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    const { installedAppId, player, minutes, reason } = parsed.data;
    try {
        const entry = await timeoutPlayer(user.id, installedAppId, player, minutes, reason);
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
    const user = await requirePermission("games.moderate");
    const parsed = z.object({ installedAppId: z.string().uuid(), player: playerNameSchema }).safeParse({
        installedAppId,
        player
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        await liftTimeout(user.id, parsed.data.installedAppId, parsed.data.player);
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
        windows: z.array(scheduleWindowSchema).max(24)
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
    const user = await requirePermission("games.manage");
    const parsed = scheduleSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        // Ownership: the schedule is written straight to the install's config, so
        // nothing else on the way would refuse somebody else's server.
        const install = await getInstalledApp(user.id, parsed.data.installedAppId);
        if (!install) return { error: "Server not found" };
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
    const user = await requirePermission("games.moderate");
    try {
        const output = await runServerCommand(user.id, installedAppId, ["whitelist", enforced ? "on" : "off"]);
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
    const user = await requirePermission("games.manage");
    const parsed = accessSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        await grantPlayerAccess(user.id, parsed.data.installedAppId, user.id, {
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

/** The list as it stands, for a screen that is not polling the server itself. */
export async function playerAccessAction(installedAppId: string): Promise<PlayerAccessView | null> {
    const user = await requirePermission("games.read");
    return listPlayerAccess(user.id, installedAppId).catch(() => null);
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
    await requirePermission("games.read");
    return { address: (await clientIp()) ?? null };
}

/** Take a player off the list, and off the server if they are on it. */
export async function revokePlayerAccessAction(
    installedAppId: string,
    username: string
): Promise<{ error?: string }> {
    const user = await requirePermission("games.manage");
    try {
        await revokePlayerAccess(user.id, installedAppId, username);
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
    const user = await requirePermission("games.manage");
    try {
        await setAddressBinding(user.id, installedAppId, enabled);
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
    const user = await requirePermission("games.manage");
    const parsed = z.string().trim().max(63).safeParse(subdomain);
    if (!parsed.success) return { error: "That subdomain is too long" };
    try {
        const install = await getInstalledApp(user.id, installedAppId);
        if (!install) throw new Error("Installed app not found");
        const hostname = await setGameHostname(user.id, installedAppId, {
            name: install.name,
            ...(parsed.data ? { subdomain: parsed.data } : {}),
            edition: install.catalogId === "minecraft-bedrock" ? "bedrock" : "java"
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
    const user = await requirePermission("games.manage");
    const parsed = z.string().trim().min(1, "Give the server a name").max(60).safeParse(name);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That name will not do" };
    try {
        const install = await getInstalledApp(user.id, installedAppId);
        if (!install) throw new Error("Server not found");
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
    const user = await requirePermission("games.manage");
    const parsed = iconSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That image will not do" };
    try {
        const bytes = Buffer.from(parsed.data.png, "base64");
        if (bytes.length === 0) throw new Error("That image is empty");
        if (bytes.length > MAX_ICON_BYTES) throw new Error("That image is too large");
        const size = pngSize(bytes);
        if (!size) throw new Error("That is not a PNG");
        if (size.width !== ICON_SIDE || size.height !== ICON_SIDE) {
            throw new Error(`A server icon has to be ${ICON_SIDE}x${ICON_SIDE}`);
        }

        const install = await getInstalledApp(user.id, parsed.data.installedAppId);
        if (!install?.applicationId) throw new Error("This server has not been deployed yet");
        await writeContainerFile(install.applicationId, user.id, ICON_PATH, bytes);
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
    const user = await requirePermission("games.moderate");
    try {
        const banned = await applyFirewallBans(user.id, installedAppId);
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
    const user = await requirePermission("games.moderate");
    try {
        const output = await runServerCommand(user.id, installedAppId, ["save-all"]);
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
    const user = await requirePermission("games.manage");
    try {
        const backup = await createWorldBackup(user.id, installedAppId);
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

/** Take an archive off the server. */
export async function deleteWorldBackupAction(installedAppId: string, name: string): Promise<{ error?: string }> {
    const user = await requirePermission("games.manage");
    const parsed = backupNameSchema.safeParse({ installedAppId, name });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That is not a backup of this server" };
    try {
        await deleteWorldBackup(user.id, parsed.data.installedAppId, parsed.data.name);
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
    const user = await requirePermission("games.manage");
    const parsed = backupNameSchema.safeParse({ installedAppId, name });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That is not a backup of this server" };
    try {
        const restored = await restoreWorldBackup(user.id, parsed.data.installedAppId, parsed.data.name, user.id);
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

/** Generate a new map, optionally carrying what every player is holding. */
export async function newWorldAction(input: NewWorldInput): Promise<{ level?: string; carried?: boolean; error?: string }> {
    const user = await requirePermission("games.manage");
    const parsed = newWorldSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const created = await newWorld(
            user.id,
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

/** Boot the server onto a map it already has. */
export async function switchWorldAction(installedAppId: string, level: string): Promise<{ error?: string }> {
    const user = await requirePermission("games.manage");
    const parsed = worldNameSchema.safeParse({ installedAppId, level });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That is not a world on this server" };
    try {
        await switchLevel(user.id, parsed.data.installedAppId, parsed.data.level, user.id);
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
    const user = await requirePermission("games.manage");
    const parsed = worldNameSchema.safeParse({ installedAppId, level });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That is not a world on this server" };
    try {
        await deleteLevel(user.id, parsed.data.installedAppId, parsed.data.level);
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
    // The console runs any command the server takes, op included, so it is the
    // full grant rather than the moderator one.
    const user = await requirePermission("games.manage");
    const parsed = consoleSchema.safeParse({ installedAppId, line });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That command is not valid" };
    try {
        const output = await runConsoleLine(user.id, parsed.data.installedAppId, parsed.data.line);
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
    const user = await requirePermission("games.manage");
    const parsed = settingsSchema.safeParse({ installedAppId, values });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the settings and try again" };
    try {
        const install = await getInstalledApp(user.id, parsed.data.installedAppId);
        if (!install?.applicationId) throw new Error("This server has not been deployed yet");
        const manifest = findApp(install.catalogId);
        if (!manifest) throw new Error("Unknown app");

        // Only what the manifest declares as tunable, only values it allows: the
        // form is a view of this list, not the authority on it.
        const tunables = tunableEnvVars(manifest);
        const vars = parsed.data.values.flatMap((entry) => {
            const field = tunables.find((item) => item.key === entry.key);
            if (!field || !isAllowedEnvValue(field, entry.value)) return [];
            return [{ key: entry.key, value: entry.value, isSecret: Boolean(field.secret) }];
        });
        if (vars.length === 0) throw new Error("Nothing to save");
        await setEnvVars("application", install.applicationId, user.id, vars);
        if (restart) await deployApplication(install.applicationId, user.id, user.id);
        revalidatePath(`/apps/installed/${parsed.data.installedAppId}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the settings" };
    }
}
