/**
 * The instance's moderation policy for Chat: the choices an administrator
 * makes once for everybody, which the per-conversation and per-person settings
 * then work inside.
 *
 * - `keep`: whether anybody may keep a disappearing message (ledger row 9).
 * - `restriction`: when many different people block or report one account in
 *   a short time, it stops reaching new people for a while (ledger row 24).
 * - `autoDownload`: what media loads on its own for somebody who never chose
 *   (ledger row 5).
 *
 * One setting row holding JSON, read total: a missing row, a row that does not
 * parse, or a field an older version did not write all fall back to the
 * defaults in `moderation-policy-rules.ts`, which are how Chat behaved before
 * the policy existed - except the spam restriction, which the owner decided
 * (2026-11-21) is on for every install at 5 different people within 7 days,
 * for 24 hours. It never touches a conversation that already exists, and an
 * administrator can change or switch it off in Chat settings.
 */

import { getSetting, setSetting } from "@/lib/setting-store";
import { DEFAULT_MODERATION_POLICY, readModerationPolicy, type ModerationPolicy } from "./moderation-policy-rules";

const KEY = "chat.policy.moderation";

export async function moderationPolicy(): Promise<ModerationPolicy> {
    return readModerationPolicy(await getSetting(KEY));
}

/** Store a whole policy. The defaults remove the row. */
export async function setModerationPolicy(next: ModerationPolicy): Promise<void> {
    const same = JSON.stringify(next) === JSON.stringify(DEFAULT_MODERATION_POLICY);
    await setSetting(KEY, same ? null : JSON.stringify(next));
}
