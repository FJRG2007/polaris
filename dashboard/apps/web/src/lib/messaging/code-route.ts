/**
 * Which channel carries a verification code, decided in one pure function so
 * the order can be asserted in a test.
 *
 * The model is the email sender's: an administrator connects a sender under
 * Integrations > Messaging and picks it for codes, and a person only gives the
 * number or the Telegram account the code goes to. Before that page existed a
 * person had to connect a WhatsApp channel of their own, so a connected channel
 * they own still carries their codes when no sender is picked - nothing that
 * worked stops working.
 */

/** The platforms a code can be sent on. */
export type CodePlatform = "whatsapp" | "telegram" | "sms";

/** The words shown when no channel can carry a code. Each names the page that fixes it. */
export const NO_CODE_SENDER: Record<CodePlatform, string> = {
    whatsapp: "WhatsApp codes are not set up. An administrator turns them on in Integrations > Messaging.",
    telegram: "Telegram codes are not set up. An administrator turns them on in Integrations > Messaging.",
    sms: "SMS codes are not set up. An administrator turns them on in Integrations > Messaging."
};

export interface CodeRouteInput {
    /** The channel an administrator picked for codes, with its stored state, if any. */
    adminSender: { id: string; platform: string; status: string } | null;
    /** The person's own connected channel on that platform, if any (the old way). */
    ownChannel: { id: string } | null;
}

export type CodeRoute = { channelId: string; via: "admin" | "own" } | { channelId: null; blocker: string };

/**
 * The admin's sender first, when it is still the right platform and connected;
 * else the person's own channel; else a blocker naming where to fix it.
 */
export function resolveCodeRoute(platform: CodePlatform, input: CodeRouteInput): CodeRoute {
    const sender = input.adminSender;
    if (sender && sender.platform === platform && sender.status === "connected") {
        return { channelId: sender.id, via: "admin" };
    }
    if (input.ownChannel) return { channelId: input.ownChannel.id, via: "own" };
    return { channelId: null, blocker: NO_CODE_SENDER[platform] };
}
