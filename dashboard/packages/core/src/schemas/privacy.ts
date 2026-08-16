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
    discoverable: "Whether people can find you",
    lastSeen: "When you were last here",
    readReceipts: "That you have read a message",
    avatar: "Your photo",
    forwarding: "Passing your messages on"
} as const;

export const PRIVACY_FIELD_NOTES = {
    discoverable:
        "Who finds your account when they look for somebody. Anybody who cannot has to know your exact username to ask to be added, and is never told whether it exists.",
    lastSeen: "Whether other people can see that you are here now, or when you last were.",
    readReceipts:
        "The ticks under a message in a direct conversation. Turning this down also stops you seeing anybody else's.",
    avatar: "Who sees your photo. Anybody who cannot gets your initials instead.",
    forwarding:
        "Who may forward something you wrote into another conversation. Anybody who cannot is not offered it, and they can still copy the text - this is a rule about the button, not a lock on your words."
} as const;

/** The order the settings are read in, so the screen does not have its own. */
export const PRIVACY_FIELDS = [
    "discoverable",
    "lastSeen",
    "readReceipts",
    "avatar",
    "forwarding"
] as const;

export const privacySettingsSchema = z.object({
    /**
     * Whether an account turns up when somebody searches for people.
     *
     * The one setting here that is not about a detail of somebody's presence but
     * about the account itself, and the reason it exists: an instance is not
     * always a company where everybody may know everybody. Two people who use the
     * same Polaris and should not know of each other must not find each other by
     * typing a letter into a picker.
     *
     * `friends` is the useful middle: invisible to a search, reachable by
     * somebody who was given the exact username - which is a thing a person
     * hands out deliberately, one at a time.
     */
    discoverable: z.enum(PRIVACY_AUDIENCES).default("everyone"),
    lastSeen: z.enum(PRIVACY_AUDIENCES).default("everyone"),
    readReceipts: z.enum(PRIVACY_AUDIENCES).default("everyone"),
    avatar: z.enum(PRIVACY_AUDIENCES).default("everyone"),
    /**
     * Whether somebody else may send what you wrote into a room you are not in.
     *
     * An audience like the rest rather than a switch, because "my friends may,
     * strangers may not" is the answer most people actually want and the
     * vocabulary for it already exists. Open by default: a conversation where
     * nothing can be passed on is not what anybody expects from a messenger, and
     * a default that quietly removed a button would read as a bug.
     *
     * What it is honestly worth is said in the note beside it. Anybody who can
     * read a message can retype it, and this does not pretend otherwise - it
     * takes away the one-press way, which is the difference between something
     * travelling because somebody meant it to and something travelling because
     * it was easy.
     */
    forwarding: z.enum(PRIVACY_AUDIENCES).default("everyone")
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
