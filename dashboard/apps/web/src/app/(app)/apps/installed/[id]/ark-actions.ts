"use server";

/**
 * What the ARK panel can do to a server. Reads live on the app's own API route
 * (they are polled); everything here changes something, so it is gated on the
 * game-server permissions, validates its input against the same rules the form
 * uses, and is recorded - letting somebody onto a server is an administrative act,
 * not a UI event.
 *
 * The two passwords are the reason this file is careful about grants. Minecraft's
 * RCON password is internal and nobody ever needs to see it; ARK's are the opposite
 * - the join password is what an operator gives their friends, and the admin one is
 * what they type into the game - so reading them back is a real feature and it is
 * the owner's alone.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import * as ark from "@/lib/apps/ark/service";
import { recordAudit } from "@/lib/audit-service";
import { findGameIdentity } from "@/lib/apps/game-identity";
import { MAX_TIMEOUT_MINUTES } from "@/lib/apps/player-timeout";
import { GAME_LOG, isJoinPassword, isSteamId } from "@/lib/apps/ark/access";
import { liftArkTimeout, timeoutArkPlayer } from "@/lib/apps/ark/timeout-service";
import { requireGameServer, requireGameServerOwner } from "@/lib/apps/install-access";

const playerSchema = z.object({
    installedAppId: z.string().trim().min(1),
    steamId: z.string().trim().refine(isSteamId, "That is not a Steam id"),
    label: z.string().trim().max(48).default("")
});

/** Let somebody onto the server. Recorded whether or not the server was up to be
 *  told - see `applyAllowList`. */
export async function addArkPlayerAction(
    installedAppId: string,
    steamId: string,
    label: string
): Promise<{ access?: ark.ArkAccessView; error?: string }> {
    const parsed = playerSchema.safeParse({ installedAppId, steamId, label });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { user, access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        const view = await ark.addAllowedPlayer(access.ownerId, parsed.data.installedAppId, {
            steamId: parsed.data.steamId,
            label: parsed.data.label
        });
        await recordAudit({
            actorId: user.id,
            action: "games.ark.allow",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { steamId: parsed.data.steamId }
        });
        return { access: view };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not add that player" };
    }
}

/** Take somebody off the server. Refused rather than recorded when the running
 *  server could not be told, so the list never claims somebody is out who is in. */
export async function removeArkPlayerAction(
    installedAppId: string,
    steamId: string
): Promise<{ access?: ark.ArkAccessView; error?: string }> {
    const parsed = playerSchema.safeParse({ installedAppId, steamId, label: "" });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That is not a Steam id" };
    try {
        const { user, access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        const view = await ark.removeAllowedPlayer(access.ownerId, parsed.data.installedAppId, parsed.data.steamId);
        await recordAudit({
            actorId: user.id,
            action: "games.ark.disallow",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { steamId: parsed.data.steamId }
        });
        return { access: view };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not remove that player" };
    }
}

/** Open or close the server to everyone who is not on the list. Takes effect on
 *  the next start, which is what the screen says. */
export async function setArkExclusiveJoinAction(
    installedAppId: string,
    closed: boolean
): Promise<{ error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        await ark.setExclusiveJoin(access.ownerId, installedAppId, closed);
        await recordAudit({
            actorId: user.id,
            action: closed ? "games.ark.close" : "games.ark.open",
            targetType: "installedApp",
            targetId: installedAppId
        });
        revalidatePath(`/apps/installed/${installedAppId}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change who may join" };
    }
}

/** Change the password players type to get in. */
export async function setArkJoinPasswordAction(
    installedAppId: string,
    password: string
): Promise<{ error?: string }> {
    const parsed = z.string().trim().refine(isJoinPassword).safeParse(password);
    if (!parsed.success) return { error: "8 to 32 letters and digits, and nothing else" };
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        await ark.setJoinPassword(access.ownerId, installedAppId, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "games.ark.password",
            targetType: "installedApp",
            targetId: installedAppId
        });
        revalidatePath(`/apps/installed/${installedAppId}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change the password" };
    }
}

/**
 * Turn the game log on or off.
 *
 * ARK records neither chat nor admin commands unless it is asked to, which is why
 * a command that the server declined leaves nothing to read anywhere. Takes effect
 * on the next start, like every other launch option.
 */
export async function setArkGameLogAction(installedAppId: string, on: boolean): Promise<{ error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        await ark.setLaunchFlag(access.ownerId, installedAppId, GAME_LOG, on);
        await recordAudit({
            actorId: user.id,
            action: on ? "games.ark.log-on" : "games.ark.log-off",
            targetType: "installedApp",
            targetId: installedAppId
        });
        revalidatePath(`/apps/installed/${installedAppId}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change the log" };
    }
}

/** Change the password that opens the in-game admin console. */
export async function setArkAdminPasswordAction(
    installedAppId: string,
    password: string
): Promise<{ error?: string }> {
    const parsed = z.string().trim().refine(isJoinPassword).safeParse(password);
    if (!parsed.success) return { error: "8 to 32 letters and digits, and nothing else" };
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        await ark.setAdminPassword(access.ownerId, installedAppId, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "games.ark.admin-password",
            targetType: "installedApp",
            targetId: installedAppId
        });
        revalidatePath(`/apps/installed/${installedAppId}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change the password" };
    }
}

/**
 * Read the two passwords back.
 *
 * The owner's alone, and never part of the poll: somebody who was invited to help
 * moderate a server was not handed its admin password, and a value that is only
 * sent when it is asked for is one a screenshot of the page does not carry.
 */
export async function revealArkPasswordsAction(
    installedAppId: string
): Promise<{ joinPassword?: string | null; adminPassword?: string | null; error?: string }> {
    try {
        const { user, access } = await requireGameServerOwner(installedAppId);
        const passwords = await ark.revealArkPasswords(access.ownerId, installedAppId);
        await recordAudit({
            actorId: user.id,
            action: "games.ark.reveal",
            targetType: "installedApp",
            targetId: installedAppId
        });
        return passwords;
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not read the passwords" };
    }
}

/**
 * The moderation verbs that work from here.
 *
 * Deliberately not teleport. ARK's teleport commands are relative to the admin's
 * own character - "to me" - and an RCON session has no character in the world, so
 * the server takes the command and does nothing, with no error either. A button
 * for it would be a button that lies; it stays an in-game command.
 */
const moderateSchema = z.object({
    installedAppId: z.string().trim().min(1),
    steamId: z.string().trim().refine(isSteamId, "That is not a Steam id"),
    verb: z.enum(["kick", "ban", "unban"])
});

export async function moderateArkPlayerAction(
    installedAppId: string,
    steamId: string,
    verb: "kick" | "ban" | "unban"
): Promise<{ error?: string }> {
    const parsed = moderateSchema.safeParse({ installedAppId, steamId, verb });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { user, access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        const run = {
            kick: ark.kickArkPlayer,
            ban: ark.banArkPlayer,
            unban: ark.unbanArkPlayer
        }[parsed.data.verb];
        await run(access.ownerId, parsed.data.installedAppId, parsed.data.steamId);
        await recordAudit({
            actorId: user.id,
            action: `games.ark.${parsed.data.verb}`,
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { steamId: parsed.data.steamId }
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The server did not accept that" };
    }
}

/**
 * Ban somebody until a moment, rather than for good.
 *
 * The verb every moderator actually wants and no game has: ARK's `BanPlayer` is
 * forever and `UnbanPlayer` is somebody remembering a week later. Polaris keeps
 * the note and lifts it - see `player-timeout-service` - so the ban list does not
 * fill up with people nobody meant to exclude permanently.
 */
const timeoutSchema = z.object({
    installedAppId: z.string().trim().min(1),
    steamId: z.string().trim().refine(isSteamId, "That is not a Steam id"),
    minutes: z.number().int().min(1).max(MAX_TIMEOUT_MINUTES),
    reason: z.string().trim().max(200).default("")
});

export async function timeoutArkPlayerAction(input: {
    installedAppId: string;
    steamId: string;
    minutes: number;
    reason?: string;
}): Promise<{ until?: string; error?: string }> {
    const parsed = timeoutSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { user, access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        const entry = await timeoutArkPlayer(
            access.ownerId,
            parsed.data.installedAppId,
            parsed.data.steamId,
            parsed.data.minutes,
            parsed.data.reason
        );
        await recordAudit({
            actorId: user.id,
            action: "games.ark.timeout",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { steamId: parsed.data.steamId, minutes: parsed.data.minutes, until: entry.until }
        });
        return { until: entry.until };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The server did not accept that" };
    }
}

/** Let them back in early, and forget the note. */
export async function liftArkTimeoutAction(installedAppId: string, steamId: string): Promise<{ error?: string }> {
    const parsed = z
        .object({
            installedAppId: z.string().trim().min(1),
            steamId: z.string().trim().refine(isSteamId, "That is not a Steam id")
        })
        .safeParse({ installedAppId, steamId });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That is not a Steam id" };
    try {
        const { user, access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        await liftArkTimeout(access.ownerId, parsed.data.installedAppId, parsed.data.steamId);
        await recordAudit({
            actorId: user.id,
            action: "games.ark.unban",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { steamId: parsed.data.steamId }
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not lift that" };
    }
}

/** Send one player a line of text, by id rather than by name - the by-name form
 *  breaks on a space and fails silently. */
export async function messageArkPlayerAction(
    installedAppId: string,
    steamId: string,
    message: string
): Promise<{ error?: string }> {
    const parsed = z
        .object({
            installedAppId: z.string().trim().min(1),
            steamId: z.string().trim().refine(isSteamId, "That is not a Steam id"),
            message: z.string().trim().min(1, "Say something").max(200)
        })
        .safeParse({ installedAppId, steamId, message });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        await ark.messageArkPlayer(
            access.ownerId,
            parsed.data.installedAppId,
            parsed.data.steamId,
            parsed.data.message
        );
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not send that message" };
    }
}

/** Write the world to disk now. */
export async function saveArkWorldAction(installedAppId: string): Promise<{ error?: string }> {
    try {
        const { access } = await requireGameServer("games.moderate", installedAppId);
        await ark.saveArkWorld(access.ownerId, installedAppId);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the world" };
    }
}

/** Say something to everyone who is playing. */
export async function broadcastArkAction(installedAppId: string, message: string): Promise<{ error?: string }> {
    const parsed = z.string().trim().min(1).max(200).safeParse(message);
    if (!parsed.success) return { error: "Say something up to 200 characters" };
    try {
        const { access } = await requireGameServer("games.moderate", installedAppId);
        await ark.broadcastToArk(access.ownerId, installedAppId, parsed.data);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not send that message" };
    }
}

/**
 * Who a Polaris name or address belongs to, and the Steam id they linked.
 *
 * The point of the whole linking flow: an operator adds a friend by the name they
 * already know them by here, and the seventeen-digit number arrives with it
 * rather than over a chat app with a digit missing.
 *
 * Three answers, because the screen has three things to say. Somebody with a
 * linked account is ready to be added; somebody with none has to link one, and
 * saying so names the person rather than leaving the operator guessing at a
 * spelling; nobody at all is a name that is not on this Polaris.
 */
export async function findArkPlayerByUserAction(
    installedAppId: string,
    query: string
): Promise<{ steamId?: string; name?: string; label?: string; error?: string }> {
    const parsed = z.string().trim().min(1).max(120).safeParse(query);
    if (!parsed.success) return { error: "Type a Polaris username or email address" };
    try {
        await requireGameServer("games.moderate", installedAppId);
        const found = await findGameIdentity(parsed.data, "steam");
        if (!found) return { error: "Nobody here goes by that. Check the username or the email address." };
        if (!found.identity) {
            // Somebody who plays through Epic has no Steam id at all, and ARK's
            // own list refuses anything else - so the answer is about the server
            // rather than about them, and it says which.
            const epic = await findGameIdentity(parsed.data, "epic").catch(() => null);
            if (epic?.identity) {
                return {
                    error: `${found.name} has linked Epic Games rather than Steam. An ARK server's list only takes Steam ids, so they have to be let in another way.`
                };
            }
            return { error: `${found.name} has not linked a Steam account yet. They can do it under Connected accounts.` };
        }
        return { steamId: found.identity.accountId, name: found.name, label: found.identity.label };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not look that up" };
    }
}
