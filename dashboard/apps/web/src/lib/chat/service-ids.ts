/**
 * The fixed account ids of the members the server runs (`service-members.ts`),
 * in a module with no imports so a screen can name them too.
 */

export const POLAR_SERVICE_ID = "00000000-0000-0000-0000-000000000001";
export const WEBHOOK_SERVICE_ID = "00000000-0000-0000-0000-000000000002";
/** The game bridge: reads a conversation a game shows to everybody playing, and posts nothing. */
export const GAME_SERVICE_ID = "00000000-0000-0000-0000-000000000003";

/** Every account the server runs, never a person's. */
export const SERVICE_ACCOUNT_IDS: readonly string[] = [POLAR_SERVICE_ID, WEBHOOK_SERVICE_ID, GAME_SERVICE_ID];
