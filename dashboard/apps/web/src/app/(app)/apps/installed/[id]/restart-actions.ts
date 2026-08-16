"use server";

/**
 * Restarting a game server, now or later.
 *
 * Some changes cannot reach a running server: ARK reads its settings and its mod
 * list when it starts, and a container's environment is only read when it boots.
 * So the panel has to be able to say "saved" without also saying "and everybody
 * playing is now disconnected", and it has to be able to come back to it.
 *
 * One module for every game, because the question is the same in both and the
 * answer - save the world, then redeploy - is too. Booking one takes the manage
 * grant, like the settings that make it necessary.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit-service";
import { requireGameServer } from "@/lib/apps/install-access";
import { MAX_RESTART_REASON, type PendingRestart } from "@/lib/apps/games-restart";
import {
    cancelRestart,
    readRestartRequest,
    requestRestart,
    runRestartNow
} from "@/lib/apps/games-restart-service";

const bookSchema = z.object({
    installedAppId: z.string().trim().min(1),
    when: z.enum(["empty", "at"]),
    /** Only for `at`, and the service refuses one that is not in the future. */
    at: z.string().trim().max(40).nullable().default(null),
    reason: z.string().trim().max(MAX_RESTART_REASON).default("")
});

/** The restart this server is waiting on, or null. A read, so anybody who may see
 *  the server may see that one is coming. */
export async function readGameRestartAction(
    installedAppId: string
): Promise<{ pending: PendingRestart | null }> {
    try {
        await requireGameServer("games.read", installedAppId);
        return { pending: await readRestartRequest(installedAppId) };
    } catch {
        return { pending: null };
    }
}

/** Book one for later. Replaces whatever was booked before: there is one server
 *  and one plan for it. */
export async function scheduleGameRestartAction(input: {
    installedAppId: string;
    when: "empty" | "at";
    at?: string | null;
    reason?: string;
}): Promise<{ pending?: PendingRestart; error?: string }> {
    const parsed = bookSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the time and try again" };
    try {
        const { user } = await requireGameServer("games.manage", parsed.data.installedAppId);
        const pending = await requestRestart(parsed.data.installedAppId, {
            when: parsed.data.when,
            at: parsed.data.at,
            reason: parsed.data.reason,
            requestedBy: user.id
        });
        await recordAudit({
            actorId: user.id,
            action: "games.restart.book",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { when: pending.when, at: pending.at ?? "", reason: pending.reason }
        });
        return { pending };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "That restart could not be booked" };
    }
}

/** Call it off. Whatever it was going to apply still applies at the next start. */
export async function cancelGameRestartAction(installedAppId: string): Promise<{ error?: string }> {
    try {
        const { user } = await requireGameServer("games.manage", installedAppId);
        await cancelRestart(installedAppId);
        await recordAudit({
            actorId: user.id,
            action: "games.restart.cancel",
            targetType: "installedApp",
            targetId: installedAppId
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "That restart could not be called off" };
    }
}

/**
 * Restart it now.
 *
 * The world is written to disk first: a restart that lost the last few minutes of
 * everybody's evening because a settings change was waiting is not a trade anybody
 * agreed to.
 */
export async function restartGameNowAction(installedAppId: string): Promise<{ error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        await runRestartNow(access.ownerId, installedAppId, user.id);
        await recordAudit({
            actorId: user.id,
            action: "games.restart.now",
            targetType: "installedApp",
            targetId: installedAppId
        });
        revalidatePath(`/apps/installed/${installedAppId}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The server could not be restarted" };
    }
}
