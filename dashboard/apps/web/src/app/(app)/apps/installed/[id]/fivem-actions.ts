"use server";

/**
 * What the FiveM panel can do to a server. Reads live on the app's own API route
 * (they are polled); everything here changes something, so it is gated on the
 * game-server permissions, validates its input against the same rules the form
 * uses, and is recorded - letting somebody onto a server is an administrative act,
 * not a UI event.
 *
 * The console password is the reason this file is careful about grants. It is not
 * an internal value like Minecraft's: it is what an operator would hand to a tool
 * of their own, so reading it back is a real feature and it is the owner's alone.
 */

import { z } from "zod";
import * as fivem from "@/lib/apps/fivem/service";
import { recordAudit } from "@/lib/audit-service";
import { isIdentifier } from "@/lib/apps/fivem/players";
import { isLicenseKey, LICENSE_KEY_HINT } from "@/lib/apps/fivem/config";
import { MAX_TIMEOUT_MINUTES } from "@/lib/apps/player-timeout";
import { findSetting, settingError } from "@/lib/apps/fivem/settings";
import { requireGameServer, requireGameServerOwner } from "@/lib/apps/install-access";
import { isResourceName, isResourceUrl, resourceNameFromUrl, type FivemResource } from "@/lib/apps/fivem/resources";
import {
    isBanReason,
    isConsolePassword,
    CONSOLE_PASSWORD_HINT,
    MAX_BAN_REASON,
    REASON_HINT
} from "@/lib/apps/fivem/access";

/** Every row on the players screen is addressed by an identifier, never a name. */
const playerSchema = z.object({
    installedAppId: z.string().uuid(),
    identifier: z.string().trim().refine(isIdentifier, "That is not a player identifier"),
    label: z.string().trim().max(48).default("")
});

/** A slot number, which is what the console's own commands take and the only
 *  thing that addresses somebody who is connected right now. */
const connectedSchema = z.object({
    installedAppId: z.string().uuid(),
    playerId: z.number().int().min(0).max(2048)
});

type AccessResult = { access?: fivem.FivemAccessView; error?: string };

function failed(caught: unknown, fallback: string): { error: string } {
    return { error: caught instanceof Error ? caught.message : fallback };
}

/** Let somebody onto the server. Recorded whether or not the server was up to be
 *  told - see `applyFivemAccess`. */
export async function addFivemPlayerAction(
    installedAppId: string,
    identifier: string,
    label: string
): Promise<AccessResult> {
    const parsed = playerSchema.safeParse({ installedAppId, identifier, label });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { user, access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        const view = await fivem.addAllowedPlayer(access.ownerId, parsed.data.installedAppId, {
            identifier: parsed.data.identifier,
            label: parsed.data.label
        });
        await recordAudit({
            actorId: user.id,
            action: "games.fivem.allow",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { identifier: parsed.data.identifier }
        });
        return { access: view };
    } catch (caught) {
        return failed(caught, "Could not add that player");
    }
}

export async function removeFivemPlayerAction(installedAppId: string, identifier: string): Promise<AccessResult> {
    const parsed = playerSchema.safeParse({ installedAppId, identifier, label: "" });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That is not a player identifier" };
    try {
        const { user, access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        const view = await fivem.removeAllowedPlayer(access.ownerId, parsed.data.installedAppId, parsed.data.identifier);
        await recordAudit({
            actorId: user.id,
            action: "games.fivem.disallow",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { identifier: parsed.data.identifier }
        });
        return { access: view };
    } catch (caught) {
        return failed(caught, "Could not remove that player");
    }
}

const banSchema = playerSchema.extend({
    reason: z.string().trim().max(MAX_BAN_REASON).refine(isBanReason, REASON_HINT),
    /** How long it lasts. Absent is a ban that does not lift by itself. */
    minutes: z.number().int().min(1).max(MAX_TIMEOUT_MINUTES).optional()
});

/**
 * Keep somebody out, for good or for a while.
 *
 * One action for both, because a timeout is a ban with an end on it - and two
 * would be two places for the reason, the kick and the audit line to drift apart.
 */
export async function banFivemPlayerAction(
    installedAppId: string,
    identifier: string,
    label: string,
    reason: string,
    minutes?: number
): Promise<AccessResult> {
    const parsed = banSchema.safeParse({ installedAppId, identifier, label, reason, minutes });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { user, access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        const until =
            parsed.data.minutes === undefined
                ? null
                : new Date(Date.now() + parsed.data.minutes * 60_000).toISOString();
        const view = await fivem.banFivemPlayer(access.ownerId, parsed.data.installedAppId, {
            identifier: parsed.data.identifier,
            label: parsed.data.label,
            reason: parsed.data.reason,
            until
        });
        await recordAudit({
            actorId: user.id,
            action: parsed.data.minutes === undefined ? "games.fivem.ban" : "games.fivem.timeout",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { identifier: parsed.data.identifier, reason: parsed.data.reason, until: until ?? "" }
        });
        return { access: view };
    } catch (caught) {
        return failed(caught, "Could not ban that player");
    }
}

export async function unbanFivemPlayerAction(installedAppId: string, identifier: string): Promise<AccessResult> {
    const parsed = playerSchema.safeParse({ installedAppId, identifier, label: "" });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That is not a player identifier" };
    try {
        const { user, access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        const view = await fivem.unbanFivemPlayer(access.ownerId, parsed.data.installedAppId, parsed.data.identifier);
        await recordAudit({
            actorId: user.id,
            action: "games.fivem.pardon",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { identifier: parsed.data.identifier }
        });
        return { access: view };
    } catch (caught) {
        return failed(caught, "Could not lift that ban");
    }
}

/** Throw somebody off. They can come straight back unless a ban or the list keeps
 *  them out, which is what the screen says beside it. */
export async function kickFivemPlayerAction(
    installedAppId: string,
    playerId: number,
    reason: string
): Promise<{ error?: string }> {
    const parsed = connectedSchema
        .extend({ reason: z.string().trim().max(MAX_BAN_REASON).refine(isBanReason, REASON_HINT) })
        .safeParse({ installedAppId, playerId, reason });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { user, access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        await fivem.kickFivemPlayer(
            access.ownerId,
            parsed.data.installedAppId,
            parsed.data.playerId,
            parsed.data.reason
        );
        await recordAudit({
            actorId: user.id,
            action: "games.fivem.kick",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { playerId: String(parsed.data.playerId), reason: parsed.data.reason }
        });
        return {};
    } catch (caught) {
        return failed(caught, "Could not kick that player");
    }
}

// The same rule a ban reason follows, and for the same reason: it reaches the
// game through a console that cannot carry a double quote.
const messageSchema = z.object({
    message: z.string().trim().min(1).max(200).refine(isBanReason, REASON_HINT)
});

/** Say something to one player, through the resource Polaris installs - the
 *  game's own console can only address the whole room. */
export async function messageFivemPlayerAction(
    installedAppId: string,
    playerId: number,
    message: string
): Promise<{ error?: string }> {
    const parsed = connectedSchema.merge(messageSchema).safeParse({ installedAppId, playerId, message });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        await fivem.messageFivemPlayer(
            access.ownerId,
            parsed.data.installedAppId,
            parsed.data.playerId,
            parsed.data.message
        );
        return {};
    } catch (caught) {
        return failed(caught, "Could not send that message");
    }
}

/** Say something to everyone who is playing. */
export async function broadcastFivemAction(installedAppId: string, message: string): Promise<{ error?: string }> {
    const parsed = z
        .object({ installedAppId: z.string().uuid() })
        .merge(messageSchema)
        .safeParse({ installedAppId, message });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        await fivem.broadcastToFivem(access.ownerId, parsed.data.installedAppId, parsed.data.message);
        return {};
    } catch (caught) {
        return failed(caught, "Could not send that message");
    }
}

/** Open or close the server to everyone who is not on the list. */
export async function setFivemExclusiveJoinAction(installedAppId: string, closed: boolean): Promise<AccessResult> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        const view = await fivem.setExclusiveJoin(access.ownerId, installedAppId, closed);
        await recordAudit({
            actorId: user.id,
            action: closed ? "games.fivem.close" : "games.fivem.open",
            targetType: "installedApp",
            targetId: installedAppId
        });
        return { access: view };
    } catch (caught) {
        return failed(caught, "Could not change who may join");
    }
}

/** Make somebody an administrator of the server, or stop them being one. */
export async function setFivemAdminAction(
    installedAppId: string,
    identifier: string,
    label: string,
    isAdmin: boolean
): Promise<AccessResult> {
    const parsed = playerSchema.safeParse({ installedAppId, identifier, label });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That is not a player identifier" };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        const view = await fivem.setFivemAdmin(
            access.ownerId,
            parsed.data.installedAppId,
            { identifier: parsed.data.identifier, label: parsed.data.label },
            isAdmin
        );
        await recordAudit({
            actorId: user.id,
            action: isAdmin ? "games.fivem.admin" : "games.fivem.unadmin",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { identifier: parsed.data.identifier }
        });
        return { access: view };
    } catch (caught) {
        return failed(caught, "Could not change who administers the server");
    }
}

/** What the server's own config holds for each rule the screen offers. */
export async function readFivemRulesAction(
    installedAppId: string
): Promise<{ rules?: fivem.FivemRule[]; error?: string }> {
    try {
        const { access } = await requireGameServer("games.read", installedAppId);
        const rules = await fivem.readFivemRules(access.ownerId, installedAppId);
        return rules === null
            ? { error: "The server has not written its config yet. Start it once and the rules appear here." }
            : { rules };
    } catch (caught) {
        return failed(caught, "Could not read the server's rules");
    }
}

/** Change them. Every one is read at boot, so the screen says the server has to
 *  be restarted rather than this doing it underneath whoever is playing. */
export async function saveFivemRulesAction(
    installedAppId: string,
    changes: Record<string, string | null>
): Promise<{ error?: string }> {
    const entries = Object.entries(changes);
    if (entries.length === 0) return {};
    if (entries.length > 64) return { error: "That is more settings than this screen has" };
    for (const [key, value] of entries) {
        const setting = findSetting(key);
        if (!setting) return { error: "That is not a setting this server has" };
        if (value !== null) {
            const problem = settingError(setting, value);
            if (problem) return { error: problem };
        }
    }
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        await fivem.writeFivemRules(access.ownerId, installedAppId, changes);
        await recordAudit({
            actorId: user.id,
            action: "games.fivem.rules",
            targetType: "installedApp",
            targetId: installedAppId,
            // The keys, never the values: one of these is a Steam API key.
            metadata: { keys: entries.map(([key]) => key).join(", ") }
        });
        return {};
    } catch (caught) {
        return failed(caught, "Could not save the server's rules");
    }
}

/** Everything the server has, and which of it is running. */
export async function listFivemResourcesAction(
    installedAppId: string
): Promise<{ resources?: FivemResource[]; error?: string }> {
    try {
        const { access } = await requireGameServer("games.read", installedAppId);
        return { resources: await fivem.listFivemResources(access.ownerId, installedAppId) };
    } catch (caught) {
        return failed(caught, "Could not read the server's resources");
    }
}

/** Start, stop or restart one. */
export async function actOnFivemResourceAction(
    installedAppId: string,
    name: string,
    action: "start" | "stop" | "restart" | "ensure"
): Promise<{ output?: string; error?: string }> {
    const parsed = z
        .object({
            installedAppId: z.string().uuid(),
            name: z.string().trim().refine(isResourceName, "That is not a resource name"),
            action: z.enum(["start", "stop", "restart", "ensure"])
        })
        .safeParse({ installedAppId, name, action });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        const output = await fivem.actOnResource(
            access.ownerId,
            parsed.data.installedAppId,
            parsed.data.name,
            parsed.data.action
        );
        await recordAudit({
            actorId: user.id,
            action: "games.fivem.resource",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { resource: parsed.data.name, did: parsed.data.action }
        });
        return { output: output.trim() };
    } catch (caught) {
        return failed(caught, "The server did not accept that");
    }
}

/** Rescan the folder, so something just added can be started. */
export async function refreshFivemResourcesAction(installedAppId: string): Promise<{ error?: string }> {
    try {
        const { access } = await requireGameServer("games.manage", installedAppId);
        await fivem.refreshResources(access.ownerId, installedAppId);
        return {};
    } catch (caught) {
        return failed(caught, "Could not rescan the resources");
    }
}

/** Fetch one from a link and put it where the server will find it. */
export async function installFivemResourceAction(
    installedAppId: string,
    url: string,
    name: string
): Promise<{ error?: string }> {
    const parsed = z
        .object({
            installedAppId: z.string().uuid(),
            url: z.string().trim().refine(isResourceUrl, "That is not a link to a resource archive"),
            name: z.string().trim().refine(isResourceName, "That is not a resource name")
        })
        .safeParse({ installedAppId, url, name });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        await fivem.installResourceFromUrl(
            access.ownerId,
            parsed.data.installedAppId,
            parsed.data.url,
            parsed.data.name
        );
        await recordAudit({
            actorId: user.id,
            action: "games.fivem.resource-install",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { resource: parsed.data.name, from: parsed.data.url }
        });
        return {};
    } catch (caught) {
        return failed(caught, "Could not install that resource");
    }
}

/** A name suggested from a link, so the field is filled in rather than asked for. */
export async function suggestFivemResourceNameAction(url: string): Promise<{ name: string }> {
    return { name: resourceNameFromUrl(url) };
}

/**
 * The console password, decrypted.
 *
 * The owner's alone, like ARK's two: it is a credential for the server rather
 * than a Polaris one, and somebody who was invited to moderate has no business
 * with it.
 */
export async function revealFivemPasswordAction(
    installedAppId: string
): Promise<{ password?: string | null; error?: string }> {
    try {
        const { access } = await requireGameServerOwner(installedAppId);
        return { password: await fivem.revealConsolePassword(access.ownerId, installedAppId) };
    } catch (caught) {
        return failed(caught, "Could not read the console password");
    }
}

/** Change it. Written to the server's config and to the deploy, so a container
 *  rebuilt from scratch comes up on the same one. */
export async function setFivemPasswordAction(installedAppId: string, password: string): Promise<{ error?: string }> {
    if (!isConsolePassword(password)) return { error: CONSOLE_PASSWORD_HINT };
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        await fivem.setConsolePassword(access.ownerId, installedAppId, password);
        await recordAudit({
            actorId: user.id,
            action: "games.fivem.console-password",
            targetType: "installedApp",
            targetId: installedAppId
        });
        return {};
    } catch (caught) {
        return failed(caught, "Could not change the console password");
    }
}

/**
 * Replace the server key.
 *
 * Write-only and never read back: it is a credential tied to the operator's own
 * Cfx account, and no screen here has any reason to print one.
 */
export async function setFivemLicenseKeyAction(installedAppId: string, key: string): Promise<{ error?: string }> {
    if (!isLicenseKey(key)) return { error: LICENSE_KEY_HINT };
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        await fivem.setLicenseKey(access.ownerId, installedAppId, key);
        await recordAudit({
            actorId: user.id,
            action: "games.fivem.license",
            targetType: "installedApp",
            targetId: installedAppId
        });
        return {};
    } catch (caught) {
        return failed(caught, "Could not change the server key");
    }
}
