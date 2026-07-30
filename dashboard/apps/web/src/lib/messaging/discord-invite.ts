/**
 * The links that finish setting up a Discord bot.
 *
 * A bot token proves the application exists; it does not put the bot anywhere.
 * Until somebody with Manage Server rights invites it, the bot is in no server,
 * cannot post, and cannot find anyone by name. Discord's own authorize page is
 * the invite: it lists the servers the person opening it can add a bot to, so
 * building the link is all Polaris has to do - no Discord account to link here,
 * and no server list of our own to keep in step with theirs.
 *
 * The permissions are the ones the adapter actually uses. Administrator would be
 * one bit and no thought, and is exactly the bit nobody should hand to a bot they
 * are still evaluating.
 */

/** Each permission the bot is asked for, with the bit Discord names it by. */
const BOT_PERMISSIONS: { label: string; bit: number }[] = [
    { label: "View channels", bit: 1 << 10 },
    { label: "Send messages", bit: 1 << 11 },
    { label: "Embed links", bit: 1 << 14 },
    { label: "Attach files", bit: 1 << 15 },
    { label: "Read message history", bit: 1 << 16 }
];

export const DISCORD_BOT_PERMISSIONS = BOT_PERMISSIONS.map((entry) => entry.label);

const PERMISSION_BITS = BOT_PERMISSIONS.reduce((total, entry) => total + entry.bit, 0);

/** A Discord id is a snowflake: digits only. The id reaches us from the bridge,
 *  which read it off the gateway, and it ends up in a URL - so it is checked. */
function isSnowflake(value: string): boolean {
    return /^\d{17,20}$/.test(value);
}

/** Where to send someone to add the bot to one of their servers, or null when
 *  the application id is not one. */
export function discordInviteUrl(applicationId: string | undefined): string | null {
    if (!applicationId || !isSnowflake(applicationId)) return null;
    return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot+applications.commands&permissions=${PERMISSION_BITS}`;
}

/** The application's own page in the Developer Portal, where the privileged
 *  intents are switched on. */
export function discordPortalUrl(applicationId: string | undefined): string | null {
    if (!applicationId || !isSnowflake(applicationId)) return null;
    return `https://discord.com/developers/applications/${applicationId}/bot`;
}
