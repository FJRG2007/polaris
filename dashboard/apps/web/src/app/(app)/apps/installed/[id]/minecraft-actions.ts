"use server";

/**
 * What the Minecraft panel can do to a server. Reads live on the app's own API
 * route (they are polled); everything here changes something, so it needs
 * deploy.manage, validates its input against the same schemas the form uses, and
 * is recorded - banning a player is an administrative act, not a UI event.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { setEnvVars } from "@/lib/env-var-service";
import { deployApplication } from "@/lib/deploy-service";
import { getInstalledApp } from "@/lib/apps/install-service";
import { findApp, isAllowedEnvValue, tunableEnvVars } from "@/lib/apps/catalog";
import { runConsoleLine, runServerCommand } from "@/lib/apps/minecraft/service";

/** A Minecraft (Java Edition) account name. */
const playerNameSchema = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{1,16}$/, "A player name is 1-16 letters, digits or underscores");

const moderationSchema = z.object({
    installedAppId: z.string().uuid(),
    action: z.enum(["op", "deop", "kick", "ban", "pardon", "whitelist-add", "whitelist-remove"]),
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
        case "whitelist-add":
            return ["whitelist", "add", input.player];
        case "whitelist-remove":
            return ["whitelist", "remove", input.player];
    }
}

export async function moderatePlayerAction(input: MinecraftModeration): Promise<{ output?: string; error?: string }> {
    const user = await requirePermission("deploy.manage");
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

/** Turn the whitelist on or off. Separate from the roster: it decides whether the
 *  list is enforced at all, which is the switch an operator actually reaches for. */
export async function setWhitelistEnforcedAction(
    installedAppId: string,
    enforced: boolean
): Promise<{ output?: string; error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const output = await runServerCommand(user.id, installedAppId, ["whitelist", enforced ? "on" : "off"]);
        return { output: output.trim() };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change the whitelist" };
    }
}

/** Flush the world to disk, for before a backup or a restart. */
export async function saveWorldAction(installedAppId: string): Promise<{ output?: string; error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const output = await runServerCommand(user.id, installedAppId, ["save-all"]);
        return { output: output.trim() };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the world" };
    }
}

/** A line typed in the console, sent as the console would send it. */
export async function sendConsoleCommandAction(
    installedAppId: string,
    line: string
): Promise<{ output?: string; error?: string }> {
    const user = await requirePermission("deploy.manage");
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
export async function updateServerSettingsAction(
    installedAppId: string,
    values: Array<{ key: string; value: string }>
): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
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
        await deployApplication(install.applicationId, user.id, user.id);
        revalidatePath(`/apps/installed/${parsed.data.installedAppId}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the settings" };
    }
}
