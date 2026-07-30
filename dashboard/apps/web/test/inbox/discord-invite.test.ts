/**
 * The Discord invite and portal links. Both are built from an id the bridge read
 * off the gateway and both end up in an href, so the failures that matter are a
 * link that goes somewhere it should not, and a link that silently points at the
 * wrong application - which would invite a bot the operator never made.
 */

import { describe, expect, it } from "vitest";
import {
    DISCORD_BOT_PERMISSIONS,
    discordInviteUrl,
    discordPortalUrl
} from "../../src/lib/messaging/discord-invite";

/** Shaped like a Discord snowflake: 18 digits. */
const APP_ID = "123456789012345678";

describe("the invite link", () => {
    it("points at Discord's authorize page for that application", () => {
        const url = discordInviteUrl(APP_ID);
        expect(url).toContain("https://discord.com/oauth2/authorize");
        expect(url).toContain(`client_id=${APP_ID}`);
    });

    it("asks for the bot scope, so Discord offers the server picker", () => {
        expect(discordInviteUrl(APP_ID)).toContain("scope=bot+applications.commands");
    });

    it("asks for what the adapter uses and never for Administrator", () => {
        // 1<<10 | 1<<11 | 1<<14 | 1<<15 | 1<<16
        expect(discordInviteUrl(APP_ID)).toContain("permissions=117760");
        expect(DISCORD_BOT_PERMISSIONS).toContain("Send messages");
        expect(DISCORD_BOT_PERMISSIONS).not.toContain("Administrator");
    });

    it("refuses anything that is not a snowflake, so nothing else reaches the URL", () => {
        expect(discordInviteUrl("../../evil")).toBeNull();
        expect(discordInviteUrl("12345")).toBeNull();
        expect(discordInviteUrl("")).toBeNull();
        expect(discordInviteUrl(undefined)).toBeNull();
    });
});

describe("the portal link", () => {
    it("opens the application's own bot page, where the intents are", () => {
        expect(discordPortalUrl(APP_ID)).toBe(
            `https://discord.com/developers/applications/${APP_ID}/bot`
        );
    });

    it("refuses a non-snowflake the same way", () => {
        expect(discordPortalUrl("not-an-id")).toBeNull();
    });
});
