/**
 * Who may see what about somebody.
 *
 * Three questions, one vocabulary. Whether people can see when you were last
 * here, whether they can see that you read their message, and whether they can
 * see your photo are all "who", and answering them with three different shapes -
 * a switch, a dropdown, a radio group - would make one idea read as three.
 *
 * Two rules are stated here rather than in a service, because both are the kind
 * of thing that quietly stops being true:
 *
 * - **Read receipts are reciprocal.** Somebody who hides that they read a
 *   message does not get to see that theirs was read. Anything else is a
 *   one-way mirror, which is not a privacy setting, and it is the rule every
 *   messenger that has this feature settled on.
 * - **An administrator sees everything.** Not as a loophole but as a stated
 *   fact: the person who runs the instance can read the database, and a setting
 *   that pretended otherwise would be a promise Polaris cannot keep. It is said
 *   in the copy on the screen for the same reason.
 */

import { z } from "zod";

/**
 * Who a piece of somebody's presence is shown to.
 *
 * `friends` means an accepted friendship in both directions, which is the only
 * kind there is - a request is not a friendship.
 */
export const PRIVACY_AUDIENCES = ["everyone", "friends", "nobody"] as const;

export type PrivacyAudience = (typeof PRIVACY_AUDIENCES)[number];

export const PRIVACY_AUDIENCE_LABELS: Record<PrivacyAudience, string> = {
    everyone: "Everybody",
    friends: "Friends only",
    nobody: "Nobody"
};

/** What each setting is, said once, so the screen and this file cannot drift. */
export const PRIVACY_FIELD_LABELS = {
    lastSeen: "When you were last here",
    readReceipts: "That you have read a message",
    avatar: "Your photo"
} as const;

export const PRIVACY_FIELD_NOTES = {
    lastSeen: "Whether other people can see that you are here now, or when you last were.",
    readReceipts:
        "The ticks under a message in a direct conversation. Turning this down also stops you seeing anybody else's.",
    avatar: "Who sees your photo. Anybody who cannot gets your initials instead."
} as const;

export const privacySettingsSchema = z.object({
    lastSeen: z.enum(PRIVACY_AUDIENCES).default("everyone"),
    readReceipts: z.enum(PRIVACY_AUDIENCES).default("everyone"),
    avatar: z.enum(PRIVACY_AUDIENCES).default("everyone")
});

export type PrivacySettings = z.infer<typeof privacySettingsSchema>;

/** What an account that has never opened the screen is on. */
export const DEFAULT_PRIVACY: PrivacySettings = privacySettingsSchema.parse({});

/**
 * Whether one person's setting lets another see it.
 *
 * Pure, and the whole rule: an audience, whether the two are friends, and
 * whether the person looking runs the instance. Separate from anything that
 * reads a database so it can be reasoned about on its own - this is the function
 * that decides whether somebody's photo is shown, and being wrong about it in
 * one direction is a leak and in the other is a bug nobody reports.
 */
export function audienceAllows(
    audience: PrivacyAudience,
    context: { readonly self: boolean; readonly friends: boolean; readonly viewerIsAdmin: boolean }
): boolean {
    // Your own screen always shows you your own. A setting that hid your photo
    // from you would be indistinguishable from a broken upload.
    if (context.self) return true;
    if (context.viewerIsAdmin) return true;
    if (audience === "everyone") return true;
    if (audience === "nobody") return false;
    return context.friends;
}

/** What a message's ticks say. */
export const MESSAGE_RECEIPTS = ["sent", "delivered", "read"] as const;

export type MessageReceipt = (typeof MESSAGE_RECEIPTS)[number];

export const MESSAGE_RECEIPT_LABELS: Record<MessageReceipt, string> = {
    sent: "Sent",
    delivered: "Delivered",
    read: "Read"
};
