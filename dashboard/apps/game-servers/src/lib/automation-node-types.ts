/**
 * Game servers' automation node types and their settings, shared by the
 * engine's side (`automation-nodes.ts`) and the editor's fields.
 */

import { z } from "zod";
import { GAME_SERVERS_APP_ID } from "@polaris/core";

export const POWER_NODE_TYPE = `${GAME_SERVERS_APP_ID}.action.power`;
export const COMMAND_NODE_TYPE = `${GAME_SERVERS_APP_ID}.action.command`;

export const POWER_ACTIONS = ["start", "stop", "restart"] as const;

/** Left loose until it is run: the line may hold `{{ }}` that only a run fills in. */
const COMMAND_TEMPLATE_LENGTH = 2000;

export const powerNodeConfig = z.object({
    installId: z.string().uuid("serverRequired"),
    action: z.enum(POWER_ACTIONS)
});
export type PowerNodeConfig = z.infer<typeof powerNodeConfig>;

export const commandNodeConfig = z.object({
    installId: z.string().uuid("serverRequired"),
    command: z.string().trim().min(1, "commandRequired").max(COMMAND_TEMPLATE_LENGTH)
});
export type CommandNodeConfig = z.infer<typeof commandNodeConfig>;
