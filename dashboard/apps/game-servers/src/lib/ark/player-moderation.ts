/**
 * One moderation verb done to a survivor on an ARK server, and the record of
 * it.
 *
 * Shared by the ARK panel's buttons and the assistant's tool, so both leave the
 * same sanction behind. The permission check and the audit line stay with each
 * caller, which knows who is asking.
 *
 * Server-only.
 */

import { banArkPlayer, kickArkPlayer, unbanArkPlayer } from "./service";
import { liftSanctions, recordSanction } from "../sanctions-service";

export const ARK_MODERATION_VERBS = ["kick", "ban", "unban"] as const;

export type ArkModerationVerb = (typeof ARK_MODERATION_VERBS)[number];

export async function moderateArkPlayer(
    ownerId: string,
    installedAppId: string,
    steamId: string,
    verb: ArkModerationVerb
): Promise<void> {
    const run = { kick: kickArkPlayer, ban: banArkPlayer, unban: unbanArkPlayer }[verb];
    await run(ownerId, installedAppId, steamId);
    if (verb === "unban") await liftSanctions(installedAppId, steamId);
    else await recordSanction({ installedAppId, player: steamId, kind: verb });
}
