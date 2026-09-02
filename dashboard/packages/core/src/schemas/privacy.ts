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
 * - **A missing list is an empty one, and `only` with an empty list is nobody.**
 *   "Only these people" naming nobody shows nobody anything, which is the safe
 *   reading and the one somebody would expect. "Everybody except" naming nobody
 *   is everybody, which is also what it says - and it is what the screen warns
 *   about the moment the audience is chosen and nobody has been picked yet.
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
    "friendsOfFriends",
    "following",
    "followers",
    "only",
    "nobody"
] as const;

export type PrivacyAudience = (typeof PRIVACY_AUDIENCES)[number];

export const PRIVACY_AUDIENCE_LABELS: Record<PrivacyAudience, string> = {
    everyone: "Everybody",
    everyoneExcept: "Everybody except",
    friends: "Friends",
    friendsExcept: "Friends except",
    friendsOfFriends: "Friends of my friends",
    following: "People I follow",
    followers: "People who follow me",
    only: "Only",
    nobody: "Nobody"
};

/**
 * The three audiences that are answered by following rather than by friendship.
 *
 * Named as a set because two things have to know it and they are far apart: the
 * screen, so it can offer them only where they mean something, and the service,
 * so it knows when it has to go and ask who follows whom rather than skipping a
 * query nothing needs. A setting that never uses them costs neither.
 */
export const REACH_AUDIENCES = ["friendsOfFriends", "following", "followers"] as const;

/** Whether an audience is answered by who follows whom. */
export function audienceNeedsReach(audience: PrivacyAudience): boolean {
    return (REACH_AUDIENCES as readonly string[]).includes(audience);
}

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
    photoFullSize: "Opening your photo",
    fullName: "Your full name",
    email: "Your email address",
    phone: "Your phone number",
    companies: "Where you work",
    followers: "The names behind your follower counts",
    friendRequests: "Who can ask to be your friend",
    fileTransfers: "Who can send you files",
    forwarding: "Passing your messages on"
} as const;

export const PRIVACY_FIELD_NOTES = {
    discoverable:
        "Who finds your account when they look for somebody. Anybody who cannot has to know your exact username to ask to be added, and is never told whether it exists.",
    lastSeen: "Whether other people can see that you are here now, or when you last were.",
    readReceipts:
        'The ticks under a message in a direct conversation. Turning this down also stops you seeing anybody else\'s, and "only" is how you leave them on for one person.',
    avatar: "Who sees your photo. Anybody who cannot gets your initials instead.",
    fullName:
        "Who sees the name on your account rather than the name you show. Anybody who cannot sees your display name, which is what every screen draws anyway.",
    photoFullSize:
        "Who can open your photo and look at it full size. Anybody who cannot still sees it beside your name - this is a rule about the press, not a second copy of the picture.",
    email: "Who sees the address you sign in with. Anybody who cannot sees your name and username, which is enough to write to you here.",
    phone: "The number kept for sign-in codes. Nobody is shown it unless you say so.",
    companies:
        "The company on your profile, and the organizations here you have chosen to show. Which organizations those are is picked one at a time on your profile; this decides who sees the ones you picked.",
    followers:
        "Who can open the two lists of names on your profile. The counts are always shown - how many follow you is a fact about you, and it is on your page the way the day you joined is - so this is about the several other people in the lists, who never chose to be on your page. Your administrator sets what a new account starts on; this is yours.",
    friendRequests:
        "Who may ask. Anybody turned down here is not told they were - the button is simply not offered - and nobody is ever stopped from following you, which asks nothing of you. Set to nobody, only the requests already waiting can still be answered.",
    forwarding:
        "Who may forward something you wrote into another conversation. Anybody who cannot is not offered it, and they can still copy the text - this is a rule about the button, not a lock on your words.",
    fileTransfers:
        "Who may offer you a file or a folder. Nothing ever lands without you accepting it, so this is about who may ask - anybody who cannot is simply not offered the button. People you share an organization with count as friends here; set to nobody, nobody can, including them."
} as const;

/** The order the settings are read in, so the screen does not have its own. */
export const PRIVACY_FIELDS = [
    "discoverable",
    "avatar",
    "photoFullSize",
    "fullName",
    "email",
    "phone",
    "companies",
    "followers",
    "friendRequests",
    "fileTransfers",
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
        fields: ["avatar", "photoFullSize", "fullName", "email", "phone", "companies", "followers"]
    },
    {
        id: "reaching",
        label: "Reaching you",
        fields: ["friendRequests", "fileTransfers"]
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

/**
 * A rule that has never been set, with its own audience baked in.
 *
 * The audience is defaulted on the inner field as well as on the whole rule,
 * and that is not belt and braces - it is the difference between a setting that
 * is shut by default and one that is not. A `.default()` on an object only fires
 * when the object itself is missing; hand it `{ audience: undefined }` - which is
 * exactly what a row with no stored value parses to - and the outer default is
 * skipped and the inner one decides. With one inner default for every field,
 * every field that arrives shut would quietly arrive open.
 */
function rule(audience: PrivacyAudience) {
    return z
        .object({
            audience: z.enum(PRIVACY_AUDIENCES).default(audience),
            listId: z.string().uuid().nullable().default(null),
            people: z.array(z.string().uuid()).max(MOST_LISTED).default([])
        })
        .default({ audience, listId: null, people: [] });
}

const open = rule("everyone");
const closed = rule("nobody");
/** Neither open nor shut: the people this account has actually agreed to know. */
const known = rule("friends");

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
     * Whether somebody may open the photo and look at it full size.
     *
     * Separate from the photo itself because they are two different questions.
     * Being recognisable in a list of names is what a photo is for, and most
     * people who are happy with that are still not offering their face as
     * something to be studied - which is the whole appeal of tapping a picture
     * in a messenger and what makes it worth being able to say no to.
     *
     * Open by default, like everything except the address and the number:
     * somebody who put a photo up put it up, and a default that quietly removed
     * the press would read as a bug.
     *
     * What it is honestly worth is said in the note beside it. The picture behind
     * a face and the picture in the viewer are the same bytes at the same
     * address - there is no second, larger copy being withheld - so this takes
     * away the one-press way to look closer and nothing else.
     */
    photoFullSize: open,
    /**
     * Who is shown the name on the account, rather than the name it shows.
     *
     * Shut by default, and that is the whole point of an account having both. A
     * display name is chosen to be seen - it is what every list, every message
     * and every mention draws - and the name behind it is an ordinary personal
     * detail, kept because forms and records ask for one. Being in a room with
     * somebody is not consent to the second, and an instance is not always a
     * company where everybody may know everybody.
     *
     * Nothing needs it to work: a person is named, mentioned, written to and
     * added to a team by the name they show.
     */
    fullName: closed,
    /**
     * Who is shown where somebody works.
     *
     * Open by default, unlike the address and the number, because it is the one
     * thing on this list that exists to be seen: a company is typed into a
     * profile in order to appear on it.
     *
     * What it governs is the whole of that answer - the line somebody typed and
     * the organizations here they marked as theirs. Which organizations those are
     * is a separate, per-organization choice made on the profile itself, and none
     * of them is shown until it is made: being on a roster is not a statement
     * somebody made about themselves, and a default that published it would be
     * this setting deciding something it was never asked.
     */
    companies: open,
    /**
     * Who may read the two lists on somebody's profile: who follows them, and
     * who they follow.
     *
     * Shut in this file, and that is not the answer people get. What a new
     * account starts on is the operator's - an instance meant as a company
     * directory and one meant as a place people follow each other want opposite
     * defaults, and neither is a decision this file can make. The stored column
     * is left unset until somebody chooses, and the service fills it in from the
     * instance setting; this is the floor for a deployment that has none.
     *
     * Both lists under one setting, because they are one disclosure: who you
     * follow is exactly as much about you as who follows you.
     */
    followers: closed,
    /**
     * Who may ask to be your friend.
     *
     * Open by default, because a request is the mildest thing one account can do
     * to another: it is answered or it is not, and nothing happens until it is.
     * The narrower answers are for the two cases people actually have - somebody
     * being asked by strangers, and an instance where being findable is not the
     * same as being reachable.
     *
     * `nobody` still leaves the requests already waiting answerable. Shutting the
     * door is not the same statement as throwing away what is already inside it,
     * and the alternative would delete other people's outstanding asks without
     * telling either side.
     */
    friendRequests: open,
    /**
     * Who may send you a file.
     *
     * Friends by default, and this is the one place the middle answer is the
     * right default rather than a compromise. A friend request is a line of
     * text; a transfer arrives as somebody else's files landing in your Drive,
     * taking your space and carrying whatever they carry. Open by default would
     * make every account on the instance reachable by anybody who can type a
     * username, which is how a shared instance becomes a way to push things at
     * people.
     *
     * Colleagues count as friends here, and only here: being put in the same
     * organization is somebody with authority over both accounts saying they
     * work together, which is a stronger statement than a friend request. That
     * is a widening of `friends`, not of `nobody` - an account that says nobody
     * means nobody, including the people it works with.
     *
     * Nothing lands without being accepted whatever this says. This decides who
     * may ASK; the answer is always the recipient's.
     */
    fileTransfers: known,
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

/**
 * What one stored value means, or what the field falls back to.
 *
 * The one way to read an audience off a row. A column holds a string somebody
 * wrote years ago, a row may not exist at all, and neither may be allowed to
 * resolve to something more open than the field's own default - which for an
 * address and a number is nobody.
 */
export function storedAudience(field: PrivacyField, stored: unknown): PrivacyAudience {
    const parsed = z.enum(PRIVACY_AUDIENCES).safeParse(stored);
    return parsed.success ? parsed.data : DEFAULT_PRIVACY[field].audience;
}

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
        /**
         * Whether the subject follows the viewer. "People I follow" is the
         * subject's sentence, so it is the subject's following that answers it.
         */
        readonly subjectFollowsViewer?: boolean;
        /** Whether the viewer follows the subject, which is what "people who
         *  follow me" asks. */
        readonly viewerFollowsSubject?: boolean;
        /** Whether the two share a friend. Absent where nothing asked, and
         *  absent reads as no - an audience answered by a fact nobody looked up
         *  must close rather than open. */
        readonly sharesAFriend?: boolean;
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
        case "friendsOfFriends":
            // A friend is a friend of a friend as well, which is what somebody
            // choosing this means: the circle widens, it does not move.
            return context.friends || (context.sharesAFriend ?? false);
        case "following":
            return context.subjectFollowsViewer ?? false;
        case "followers":
            return context.viewerFollowsSubject ?? false;
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

/**
 * How many people one account may block.
 *
 * A ceiling rather than a rule anybody will meet: it exists because a list with
 * no limit is a list somebody can be made to write to forever, and because every
 * check on the way to reaching somebody reads this list. A few hundred is well
 * past any real use of it and still small enough to hold in memory.
 */
export const MOST_BLOCKED = 500;

/** Blocking or unblocking one account. Who is doing it comes from the session
 *  rather than from here: an id in a payload deciding whose block list is
 *  written would be the whole vulnerability. */
export const blockSchema = z.object({
    userId: z.string().uuid()
});

export type BlockInput = z.infer<typeof blockSchema>;
