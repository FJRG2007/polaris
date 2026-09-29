"use server";

/**
 * A Minecraft server's challenges: reading them, setting them up and dealing a
 * player afresh.
 *
 * Reading is the console's grant, like the events: challenges talk to everybody
 * on the server and hand out items, which is what somebody with the console can
 * do by typing.
 *
 * Every reply is in the reader's language. Only a `ChallengeRefusal` says what
 * went wrong; anything else is logged here and answered with a generic sentence.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { gameCatalogs, type ChallengesKey } from "../../../messages";
import * as challenges from "../../lib/minecraft/challenges/challenges-service";

const { recordAudit } = host.auditService;
const { requireGameServer } = host.appsInstallAccess;

const serverId = z.string().uuid();

type Answer = { view?: challenges.ChallengesView; error?: string };

async function translator() {
    return gameCatalogs.translator(await host.i18nRequest.getLocale(), "challenges");
}

/** A redirect or a not-found from the framework passes through untouched. */
function isFrameworkSignal(caught: unknown): boolean {
    const digest = (caught as { digest?: unknown } | null)?.digest;
    return typeof digest === "string" && digest.startsWith("NEXT_");
}

async function failure(caught: unknown, fallback: ChallengesKey): Promise<Answer> {
    if (isFrameworkSignal(caught)) throw caught;
    const t = await translator();
    if (caught instanceof challenges.ChallengeRefusal) {
        return {
            error: caught.key.startsWith("errors.") ? t(caught.key as ChallengesKey) : t(fallback)
        };
    }
    if (caught instanceof Error && caught.message === "Server not found")
        return { error: t("errors.notHere") };
    console.warn("polaris: challenges action failed", String(caught));
    return { error: t(fallback) };
}

export async function readChallengesAction(installedAppId: string): Promise<Answer> {
    const parsed = serverId.safeParse(installedAppId);
    if (!parsed.success) return { error: (await translator())("errors.notHere") };
    try {
        await requireGameServer("games.console", parsed.data);
        return { view: await challenges.challengesView(parsed.data) };
    } catch (caught) {
        return failure(caught, "errors.readFailed");
    }
}

const saveSchema = z.object({ installedAppId: serverId, settings: z.unknown() });

export async function saveChallengesAction(input: z.input<typeof saveSchema>): Promise<Answer> {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return { error: (await translator())("errors.notHere") };
    try {
        const { user } = await requireGameServer("games.console", parsed.data.installedAppId);
        await challenges.saveSettings(parsed.data.installedAppId, parsed.data.settings);
        await recordAudit({
            actorId: user.id,
            action: "games.challenges.settings",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId
        });
        return { view: await challenges.challengesView(parsed.data.installedAppId) };
    } catch (caught) {
        return failure(caught, "errors.saveFailed");
    }
}

const resetSchema = z.object({
    installedAppId: serverId,
    player: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_.]{1,16}$/)
});

export async function resetChallengePlayerAction(
    input: z.input<typeof resetSchema>
): Promise<Answer> {
    const parsed = resetSchema.safeParse(input);
    if (!parsed.success) return { error: (await translator())("errors.playerNotHere") };
    try {
        const { user } = await requireGameServer("games.console", parsed.data.installedAppId);
        await challenges.resetPlayer(parsed.data.installedAppId, parsed.data.player);
        await recordAudit({
            actorId: user.id,
            action: "games.challenges.reset-player",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { player: parsed.data.player }
        });
        return { view: await challenges.challengesView(parsed.data.installedAppId) };
    } catch (caught) {
        return failure(caught, "errors.resetFailed");
    }
}
