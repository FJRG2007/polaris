/**
 * Who may see what about somebody.
 *
 * One vocabulary for every question. Whether people can see when you were last
 * here, whether they can see that you read their message, whether they can see
 * your photo, your address or your number are all "who", and answering them with
 * different shapes - a switch, a dropdown, a radio group - would make one idea
 * read as five.
 *
 * The vocabulary has six words rather than three, and the three extra ones are
 * the answer people actually give. "Everybody except my manager" and "only these
 * two" are the real settings; a chooser offering everybody, friends or nobody
 * makes somebody who wants either of those pick the closest wrong one. The set of
 * people is kept separately (a list, which can be saved and used again) so the
 * same three or four names do not have to be picked over and over.
 *
 * Three rules are stated here rather than in a service, because all three are
 * the kind of thing that quietly stops being true:
 *
 * - **Read receipts are reciprocal.** Somebody who hides that they read a
 *   message does not get to see that theirs was read. Anything else is a
 *   one-way mirror, which is not a privacy setting, and it is the rule every
 *   messenger that has this feature settled on.
 * - **An administrator sees everything.** Not as a loophole but as a stated
 *   fact: the person who runs the instance can read the database, and a setting
 *   that pretended otherwise would be a promise Polaris cannot keep. It is said
 *   in the copy on the screen for the same reason.
 * - **An audience that names a list and has none shows nothing.** A rule whose
 *   list was deleted is a rule nobody can read; falling back to "everybody"
 *   would turn losing a list into a disclosure.
 */

import { z } from "zod";

/**
 * Who a piece of somebody's presence is shown to.
 *
 * `friends` means an accepted friendship in both directions, which is the only
 * kind there is - a request is not a friendship. The two `Except` audiences and
 * `only` each name a list of people; everything else ignores it.
 */
export const PRIVACY_AUDIENCES = [
    "everyone",
    "everyoneExcept",
    "friends",
    "friendsExcept",
    "only",
    "nobody"
] as const;

export type PrivacyAudience = (typeof PRIVACY_AUDIENCES)[number];

export const PRIVACY_AUDIENCE_LABELS: Record<PrivacyAudience, string> = {
    everyone: "Everybody",
    everyoneExcept: "Everybody except",
    friends: "Friends",
    friendsExcept: "Friends except",
    only: "Only",
    nobody: "Nobody"
};

/** Whether an audience is incomplete until a set of people is chosen for it. */
export function audienceNeedsList(audience: PrivacyAudience): boolean {
    return audience === "everyoneExcept" || audience === "friendsExcept" || audience === "only";
}

/** What each setting is, said once, so the screen and this file cannot drift. */
export const PRIVACY_FIELD_LABELS = {
    discoverable: "Whether people can find you",
    lastSeen: "When you were last here",
    readReceipts: "That you have read a message",
    avatar: "Your photo",
    email: "Your email address",
    phone: "Your phone number",
    forwarding: "Passing your messages on"
} as const;

export const PRIVACY_FIELD_NOTES = {
    discoverable:
        "Who finds your account when they look for somebody. Anybody who cannot has to know your exact username to ask to be added, and is never told whether it exists.",
    lastSeen: "Whether other people can see that you are here now, or when you last were.",
    readReceipts:
        "The ticks under a message in a direct conversation. Turning this down also stops you seeing anybody else's, and \"only\" is how you leave them on for one person.",
    avatar: "Who sees your photo. Anybody who cannot gets your initials instead.",
    email: "Who sees the address you sign in with. Anybody who cannot sees your name and username, which is enough to write to you here.",
    phone: "The number kept for sign-in codes. Nobody is shown it unless you say so.",
    forwarding:
        "Who may forward something you wrote into another conversation. Anybody who cannot is not offered it, and they can still copy the text - this is a rule about the button, not a lock on your words."
} as const;

/** The order the settings are read in, so the screen does not have its own. */
export const PRIVACY_FIELDS = [
    "discoverable",
    "avatar",
    "email",
    "phone",
    "lastSeen",
    "readReceipts",
    "forwarding"
] as const;

export type PrivacyField = (typeof PRIVACY_FIELDS)[number];

/**
 * The settings, in groups.
 *
 * Seven rows in one undifferentiated list is a wall, and the same wall the
 * capabilities on an account had before they were grouped by area. The headings
 * are what somebody scans: "where is my number" is answered by a heading, never
 * by reading every row.
 */
export const PRIVACY_SECTIONS = [
    {
        id: "finding",
        label: "Being found",
        fields: ["discoverable"]
    },
    {
        id: "details",
        label: "Your details",
        fields: ["avatar", "email", "phone"]
    },
    {
        id: "presence",
        label: "Presence",
        fields: ["lastSeen"]
    },
    {
        id: "messages",
        label: "Messages",
        fields: ["readReceipts", "forwarding"]
    }
] as const satisfies readonly {
    id: string;
    label: string;
    fields: readonly PrivacyField[];
}[];

/** How many people one list holds. Past this it is not a list of exceptions, it
 *  is the audience - and the setting for that is one of the other five. */
export const MOST_LISTED = 200;

/**
 * One answer: an audience, and the people it names when it names any.
 *
 * Two ways to name them, because both are things people do. `people` is the set
 * picked on the setting's own row - the common case, and the one that must not
 * require going somewhere else first. `listId` is a list they saved under a name
 * and use for more than one setting, which is what stops the same four names
 * being re-picked in five places and drifting apart.
 *
 * Exactly one of them is in play: a rule pointing at a saved list carries no
 * people of its own, and one with its own people points at no list.
 */
export const privacyRuleSchema = z.object({
    audience: z.enum(PRIVACY_AUDIENCES).default("everyone"),
    listId: z.string().uuid().nullable().default(null),
    people: z.array(z.string().uuid()).max(MOST_LISTED).default([])
});

export type PrivacyRule = z.infer<typeof privacyRuleSchema>;

/** A rule that has never been set. Written out rather than parsed per field so
 *  the defaults below read as the decisions they are. */
const open = privacyRuleSchema.default({ audience: "everyone", listId: null, people: [] });
const closed = privacyRuleSchema.default({ audience: "nobody", listId: null, people: [] });

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
    discoverable: open,
    lastSeen: open,
    readReceipts: open,
    avatar: open,
    /**
     * Who is shown the address the account signs in with.
     *
     * Closed by default, and the only reason it is not open like the rest: an
     * address is not a detail of somebody's presence, it is the thing spam,
     * password resets and impersonation all start from. Polaris showed it beside
     * every name on an organization's roster, which handed a whole company's
     * addresses to anybody invited into it for an afternoon.
     *
     * Nothing needs it to work. A person is named, mentioned, written to and
     * added to a team by their name and username; the address is only ever a
     * disclosure.
     */
    email: closed,
    /** Closed by default for the same reason as the address, and more so: a
     *  number is kept here to receive sign-in codes, and it is the one detail
     *  that reaches somebody when they are nowhere near this instance. */
    phone: closed,
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
    forwarding: open
});

export type PrivacySettings = z.infer<typeof privacySettingsSchema>;

/** What an account that has never opened the screen is on. */
export const DEFAULT_PRIVACY: PrivacySettings = privacySettingsSchema.parse({});

/** What one account's list is called and who is on it. */
export const privacyListSchema = z.object({
    name: z.string().trim().min(1, "Give the list a name").max(60),
    members: z.array(z.string().uuid()).max(MOST_LISTED)
});

export type PrivacyListInput = z.infer<typeof privacyListSchema>;

/**
 * Whether one person's setting lets another see it.
 *
 * Pure, and the whole rule: an audience, whether the two are friends, whether
 * the person looking is on the list the rule names, and whether they run the
 * instance. Separate from anything that reads a database so it can be reasoned
 * about on its own - this is the function that decides whether somebody's photo
 * is shown, and being wrong about it in one direction is a leak and in the other
 * is a bug nobody reports.
 */
export function audienceAllows(
    audience: PrivacyAudience,
    context: {
        readonly self: boolean;
        readonly friends: boolean;
        readonly viewerIsAdmin: boolean;
        /** Whether the viewer is on the set of people the rule names. False when
         *  it names none, which is why the `Except` audiences stay open and
         *  `only` stays shut. */
        readonly inList?: boolean;
    }
): boolean {
    // Your own screen always shows you your own. A setting that hid your photo
    // from you would be indistinguishable from a broken upload.
    if (context.self) return true;
    if (context.viewerIsAdmin) return true;

    const listed = context.inList ?? false;
    switch (audience) {
        case "everyone":
            return true;
        case "everyoneExcept":
            return !listed;
        case "friends":
            return context.friends;
        case "friendsExcept":
            return context.friends && !listed;
        case "only":
            return listed;
        case "nobody":
            return false;
    }
}

/** What a message's ticks say. */
export const MESSAGE_RECEIPTS = ["sent", "delivered", "read"] as const;

export type MessageReceipt = (typeof MESSAGE_RECEIPTS)[number];

export const MESSAGE_RECEIPT_LABELS: Record<MessageReceipt, string> = {
    sent: "Sent",
    delivered: "Delivered",
    read: "Read"
};
