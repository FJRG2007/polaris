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
    "spaces",
    "smallSpaces",
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
    spaces: "Friends and server members",
    smallSpaces: "Friends and small server members",
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

/**
 * How many people a chat space holds before it stops counting as small.
 *
 * "Small" is fewer than this, counting the owner, who is never a member row. A
 * room of a few friends and a public community of thousands are both "a server
 * I am in", and only the first is people somebody would show their profile to.
 */
export const SMALL_SPACE_MEMBERS = 200;

/** Whether a space with this many people in it, owner included, is small. */
export function isSmallSpace(people: number): boolean {
    return people < SMALL_SPACE_MEMBERS;
}

/** The two audiences answered by sharing a chat space, so the service only asks
 *  who shares a space when somebody's answer turns on it. */
export const SPACE_AUDIENCES = ["spaces", "smallSpaces"] as const;

/** What "who can see your profile" offers: the circles people actually draw
 *  around a profile, widest first. */
export const PROFILE_AUDIENCES = [
    "everyone",
    "spaces",
    "smallSpaces",
    "friends",
    "nobody"
] as const satisfies readonly PrivacyAudience[];

/** Whether an audience is answered by the chat spaces two people share. */
export function audienceNeedsSpaces(audience: PrivacyAudience): boolean {
    return (SPACE_AUDIENCES as readonly string[]).includes(audience);
}

/** Whether an audience is incomplete until a set of people is chosen for it. */
export function audienceNeedsList(audience: PrivacyAudience): boolean {
    return audience === "everyoneExcept" || audience === "friendsExcept" || audience === "only";
}

/** What each setting is, said once, so the screen and this file cannot drift. */
export const PRIVACY_FIELD_LABELS = {
    profile: "Who can see your profile",
    discoverable: "Finding you by username",
    findByEmail: "Finding you by email",
    findByPhone: "Finding you by phone number",
    lastSeen: "Whether you are shown online",
    lastActive: "When you were last online",
    activity: "What you are playing or listening to",
    badges: "Your badges",
    readReceipts: "That you have read a message",
    typing: "That you are typing",
    avatar: "Your photo",
    photoFullSize: "Opening your photo",
    fullName: "Your full name",
    email: "Your email address",
    phone: "Your phone number",
    companies: "Where you work",
    followers: "The names behind your follower counts",
    friendRequests: "Who can ask to be your friend",
    fileTransfers: "Who can send you files",
    calls: "Who can call you",
    groupAdds: "Who can add you to groups",
    forwarding: "Passing your messages on"
} as const;

export const PRIVACY_FIELD_NOTES = {
    profile:
        "Your bio, links, pronouns and banner. Anybody else sees only your name and photo. Small servers are those with fewer than 200 members.",
    discoverable:
        "Who finds your account by your username or name. Anybody who cannot has to know your exact username to ask to be added, and is never told whether it exists.",
    findByEmail:
        "Who finds your account by typing your whole email address, when this instance allows it. Finding you never shows them the address.",
    findByPhone:
        "Who finds your account by typing your whole phone number, when this instance allows it. Finding you never shows them the number.",
    lastSeen: "The dot beside your name and the status under it. Anybody who cannot see it sees you as offline.",
    lastActive:
        "The time shown under your name while you are away, such as last seen today at 14:32. Turning this down also stops you seeing anybody else's.",
    badges: "Who sees the badges on your profile and how far you are with each. A badge can have its own rule, set on its row under Badges.",
    activity:
        "The game or song shown beside your name. Only ever shown to people who can also see that you are here, and never while you appear offline.",
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
    typing:
        "The dots shown while you write. Turning this down also stops you seeing anybody else's.",
    forwarding:
        "Who may forward something you wrote into another conversation. Anybody who cannot is not offered it, and they can still copy the text - this is a rule about the button, not a lock on your words.",
    calls: "Who may ring you. A call takes over the screen of whatever you were doing and makes a noise in the room you are in, which is why this starts at your friends rather than at everybody. Joining a voice channel is not this: that is a room somebody walked into, and who may be in it is the room's own question. Anybody who cannot call you is simply not offered the button.",
    groupAdds:
        "Who may put you in a group conversation. Friends and people in your organizations by default; anybody else who tries is told you cannot be added.",
    fileTransfers:
        "Who may offer you a file or a folder. Nothing ever lands without you accepting it, so this is about who may ask - anybody who cannot is simply not offered the button. People you share an organization with count as friends here; set to nobody, nobody can, including them."
} as const;

/** The order the settings are read in, so the screen does not have its own. */
export const PRIVACY_FIELDS = [
    "discoverable",
    "findByEmail",
    "findByPhone",
    "profile",
    "avatar",
    "photoFullSize",
    "fullName",
    "email",
    "phone",
    "companies",
    "followers",
    "friendRequests",
    "fileTransfers",
    "calls",
    "groupAdds",
    "lastSeen",
    "lastActive",
    "activity",
    "badges",
    "readReceipts",
    "typing",
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
        fields: ["discoverable", "findByEmail", "findByPhone"]
    },
    {
        id: "details",
        label: "Your details",
        fields: [
            "profile",
            "avatar",
            "photoFullSize",
            "fullName",
            "email",
            "phone",
            "companies",
            "followers"
        ]
    },
    {
        id: "reaching",
        label: "Reaching you",
        fields: ["friendRequests", "fileTransfers", "calls", "groupAdds"]
    },
    {
        id: "presence",
        label: "Presence",
        fields: ["lastSeen", "lastActive", "activity", "badges"]
    },
    {
        id: "messages",
        label: "Messages",
        fields: ["readReceipts", "typing", "forwarding"]
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
     * Whether an account turns up when somebody searches for people by
     * username or name. The whole address and the whole number are their own
     * settings, `findByEmail` and `findByPhone`.
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
    /**
     * Who finds the account by typing its whole email address - the main one or
     * one it added and confirmed. Never prints the address back: whether that is
     * shown is `email`. Only ever asked when the instance's discovery policy lets
     * an address find somebody at all, which it does not by default, so this is
     * open the way `discoverable` is and the operator's switch is the gate.
     */
    findByEmail: open,
    /** The same for the whole, confirmed phone number. */
    findByPhone: open,
    /**
     * Who may read somebody's profile: what they wrote about themselves, their
     * links, pronouns, banner, who they follow and what they share with you.
     *
     * Open by default, which is what every account was on before this existed,
     * so nothing changes until somebody chooses. Anybody outside the audience
     * still gets the card a name needs - the display name, the handle and the
     * photo as the photo setting allows - because a name nobody can put a face
     * to is a broken screen rather than a private one. That is also what the
     * messengers with this setting draw.
     */
    profile: open,
    /**
     * Whether somebody is shown online at all: the dot and the status under it.
     * The key predates the time below and is kept so no stored row moves.
     */
    lastSeen: open,
    /**
     * When somebody was last here, as a time - "last seen today at 14:32".
     *
     * Separate from the dot because they are two disclosures: being seen to be
     * here now is one, and a record of when you stopped being here is another
     * that people turn off on its own in every messenger that has both.
     * Reciprocal like the ticks, and only ever shown to a reader who may see the
     * dot - somebody hidden or invisible has no time either.
     */
    lastActive: open,
    /**
     * Who sees what somebody is doing: the game, the song, the server.
     *
     * Open by default, which is the answer every place that shows this settled
     * on, and safe for one reason stated here because it is what makes it safe:
     * an activity is only ever drawn for a reader who can already see that the
     * person is here. So this narrows the `lastSeen` audience and can never
     * widen it - somebody hidden from a reader is hidden with everything they
     * are doing, and somebody invisible is doing nothing at all.
     */
    activity: open,
    badges: open,
    readReceipts: open,
    /** Whether the dots that say somebody is writing reach a reader.
     *  Reciprocal like the ticks: hide yours and you see nobody's. */
    typing: open,
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
     * Open, which is what following is for. Every place people follow each other
     * publishes both lists and lets somebody close them - it is how a follow is
     * discovered at all, and a graph nobody can see is a graph nobody joins.
     *
     * What a new account actually starts on is still the operator's: an instance
     * meant as a company directory and one meant as a place people follow each
     * other want opposite answers, and neither is a decision this file can make.
     * The stored column is left unset until somebody chooses and the service
     * fills it in from the instance setting; this is only the floor for a
     * deployment that has never set one.
     *
     * Both lists under one setting, because they are one disclosure: who you
     * follow is exactly as much about you as who follows you.
     */
    followers: open,
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
     * Who may ring this account.
     *
     * Friends by default, which is the middle answer and the right one for the
     * same reason the transfer above it takes it: a call is the loudest thing
     * one account can do to another. It takes over the screen of whatever
     * somebody was doing and makes a noise in the room they are in, and open by
     * default would make every account here reachable that way by anybody who
     * can type a username.
     *
     * Joining a voice channel is deliberately not this. That is a room somebody
     * walked into, and who may be in it is the room's question rather than a
     * property of the people already there - the setting would otherwise mean
     * that being in a channel decided who else could use it.
     *
     * Anybody who may not is not told so: the button is not offered, which is
     * the same shape every other refusal here takes.
     */
    calls: known,
    groupAdds: known,
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
 * What the Privacy Checkup (ledger row 12) suggests for each field: the
 * circle of people who already know you, and nobody for what a stranger could
 * misuse. Only ever applied when somebody presses "Use recommended" on a step;
 * nothing reads it as a default.
 */
export const RECOMMENDED_PRIVACY: Record<PrivacyField, PrivacyAudience> = {
    discoverable: "friendsOfFriends",
    findByEmail: "nobody",
    findByPhone: "nobody",
    profile: "friends",
    avatar: "friends",
    photoFullSize: "friends",
    fullName: "nobody",
    email: "nobody",
    phone: "nobody",
    companies: "friends",
    followers: "friends",
    friendRequests: "friendsOfFriends",
    fileTransfers: "friends",
    calls: "friends",
    groupAdds: "friends",
    lastSeen: "friends",
    lastActive: "friends",
    activity: "friends",
    badges: "friends",
    readReceipts: "friends",
    typing: "friends",
    forwarding: "friends"
};

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

/**
 * What an administrator may set a field to for accounts that never chose.
 *
 * Only the audiences that name nobody in particular: a list belongs to an
 * account, and a default is set before there is one to have it. The profile
 * offers the narrower set its own row does.
 */
export const PRIVACY_DEFAULT_AUDIENCES = PRIVACY_AUDIENCES.filter(
    (audience) => !audienceNeedsList(audience)
);

export function defaultAudiencesFor(field: PrivacyField): readonly PrivacyAudience[] {
    return field === "profile" ? PROFILE_AUDIENCES : PRIVACY_DEFAULT_AUDIENCES;
}

/**
 * What one field resolves to for one account.
 *
 * A stored value is the person's own choice. A null column - or no row at all -
 * means they never chose, and then the administrator's default decides, and the
 * code's own default only where the administrator never set one. An operator
 * default that names a list, or that the field does not offer, is ignored
 * rather than trusted.
 *
 * `locked` is the administrator holding the field to their default: then the
 * person's own choice is not consulted at all. It stays stored, so lifting the
 * lock gives it back, but nothing reads it while the lock stands. Off unless an
 * administrator set it, so every existing account resolves as it did.
 */
export function resolvedAudience(
    field: PrivacyField,
    stored: unknown,
    operatorDefault: unknown,
    locked = false
): PrivacyAudience {
    const own = z.enum(PRIVACY_AUDIENCES).safeParse(locked ? null : stored);
    if (own.success) return own.data;
    const operator = z.enum(PRIVACY_AUDIENCES).safeParse(operatorDefault);
    if (operator.success && defaultAudiencesFor(field).includes(operator.data)) {
        return operator.data;
    }
    return DEFAULT_PRIVACY[field].audience;
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
        /** Whether the two are both in some chat space. Absent reads as no. */
        readonly sharesSpace?: boolean;
        /** Whether one of the spaces they share is small (`isSmallSpace`).
         *  Absent reads as no. */
        readonly sharesSmallSpace?: boolean;
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
        case "spaces":
            // Friends first, then anybody in a room with them: the circle the
            // label names, not a different one.
            return context.friends || (context.sharesSpace ?? false);
        case "smallSpaces":
            return context.friends || (context.sharesSmallSpace ?? false);
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

/**
 * A conversation's own rule for read receipts and for the typing indicator:
 * "follow" leaves it to each person's account setting, "on" shows it to
 * everybody in the conversation, "off" to nobody. Inside that conversation the
 * conversation's rule wins over the account's.
 */
export const CHAT_PRIVACY_RULES = ["follow", "on", "off"] as const;
export type ChatPrivacyRule = (typeof CHAT_PRIVACY_RULES)[number];
export const chatPrivacyRuleSchema = z.enum(CHAT_PRIVACY_RULES);

/** One change to a conversation's privacy rules: any of the three, at least one. */
export const chatPrivacyChangeSchema = z
    .object({
        receipts: chatPrivacyRuleSchema.optional(),
        typing: chatPrivacyRuleSchema.optional(),
        vanishAfter: z.number().int().min(0).optional()
    })
    .strict()
    .refine(
        (change) =>
            change.receipts !== undefined || change.typing !== undefined || change.vanishAfter !== undefined,
        { message: "Nothing to change" }
    );
export type ChatPrivacyChange = z.infer<typeof chatPrivacyChangeSchema>;
