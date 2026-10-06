/**
 * One moderation verb done to a player on a Minecraft server, and the record
 * of it.
 *
 * Shared by the Players tab's buttons and the assistant's tool, so a kick from
 * either reaches the server by the same route and leaves the same sanction
 * behind - a ban recorded from one and not the other would be a player whose
 * account says they were never banned. The permission check and the audit line
 * stay with each caller, which knows who is asking.
 *
 * Server-only.
 */

import { withServerContainer } from "./service";
import { applyOnContainer } from "./player-access";
import { liftSanctions, recordSanction } from "../sanctions-service";

export const MODERATION_VERBS = [
    "op",
    "deop",
    "kick",
    "ban",
    "pardon",
    "kill",
    "whitelist-add",
    "whitelist-remove"
] as const;

export type ModerationVerb = (typeof MODERATION_VERBS)[number];

export interface PlayerModeration {
    readonly action: ModerationVerb;
    readonly player: string;
    /** Shown to the player being kicked or banned. */
    readonly reason?: string | undefined;
}

/** The command each moderation verb sends, as argv. */
export function moderationArgv(input: PlayerModeration): string[] {
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

/**
 * Carry one moderation out, by whichever route this server will actually
 * honour, and keep the sanction it leaves.
 *
 * How each verb has to reach an unauthenticated server is decided in
 * `player-access`, not here, and this opens the server once and hands it over.
 * One connection rather than two: the command and the file that has to be
 * settled behind it used to open the container separately, which on a server
 * registered across an SSH link is two handshakes for one button.
 */
export async function moderatePlayer(
    ownerId: string,
    installedAppId: string,
    input: PlayerModeration
): Promise<string> {
    const output = await withServerContainer(ownerId, installedAppId, (server) =>
        applyOnContainer(server, input.action, input.player, moderationArgv(input))
    );
    if (input.action === "kick" || input.action === "ban")
        await recordSanction({
            installedAppId,
            player: input.player,
            kind: input.action,
            reason: input.reason
        });
    else if (input.action === "pardon") await liftSanctions(installedAppId, input.player);
    return output;
}
