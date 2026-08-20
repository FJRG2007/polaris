/**
 * Where an account stands with the instance it lives on.
 *
 * Five steps rather than a switch, because "you are fine" and "you are gone" are
 * not the only two things that can be true and an account that only ever hears
 * from moderation at the moment it is suspended has been given no chance to
 * change anything. A ladder somebody can look at says where they are before it
 * matters.
 *
 * What moves them along it is a report that was upheld: somebody objected to
 * something they wrote and a moderator agreed and took it down. Not a report
 * being made - anybody can make one about anything, and a standing that moved on
 * accusations would be a standing anybody could push somebody down. Only the
 * decision counts.
 *
 * Upheld reports age out, and that is deliberate: a ladder that only goes one way
 * is a ladder nobody has a reason to climb back up. The window is long enough to
 * be a record and short enough to be forgettable.
 *
 * Pure, and separate from anything that reads a database, because it is the one
 * rule the screen and the tests both have to agree on.
 */

/** The steps, best first. The order is the order they are drawn in. */
export const ACCOUNT_STANDINGS = ["good", "limited", "veryLimited", "atRisk", "suspended"] as const;

export type AccountStanding = (typeof ACCOUNT_STANDINGS)[number];

/** What each step is called under its mark on the ladder. */
export const ACCOUNT_STANDING_LABELS: Record<AccountStanding, string> = {
    good: "All good!",
    limited: "Limited",
    veryLimited: "Very limited",
    atRisk: "At risk",
    suspended: "Suspended"
};

/** The same, as it reads in the sentence "Your account is ...". */
export const ACCOUNT_STANDING_WORDS: Record<AccountStanding, string> = {
    good: "all good",
    limited: "limited",
    veryLimited: "very limited",
    atRisk: "at risk",
    suspended: "suspended"
};

/**
 * What the step means, said in terms of what actually happened.
 *
 * Written as facts rather than warnings on purpose: Polaris does not take
 * anything away from an account for being on the second step, so copy that
 * implied it would be a threat nobody would carry out. What limits somebody here
 * is a timeout or a ban in a particular place, and the screen lists those
 * underneath in as many words.
 */
export const ACCOUNT_STANDING_NOTES: Record<AccountStanding, string> = {
    good: "Nothing has been upheld against your account. If a moderator ever takes something of yours down, it shows up here.",
    limited: "One thing you posted was taken down after somebody reported it.",
    veryLimited: "Two things you posted were taken down after somebody reported them.",
    atRisk: "Several things you posted have been taken down after being reported. Another may cost you the account.",
    suspended: "This account has been suspended and cannot sign in."
};

/**
 * How long an upheld report counts for.
 *
 * Ninety days is the span every service that does this settled on, and the
 * reasoning is the same everywhere: long enough that three of them inside it is
 * a pattern rather than a bad week, short enough that somebody who changed how
 * they behave is not still paying for last year.
 */
export const ACCOUNT_STANDING_WINDOW_DAYS = 90;

/**
 * Where an account stands.
 *
 * Suspension is not a count and outranks everything: an account with no upheld
 * report at all can be suspended for one thing bad enough, and one that has been
 * suspended is not "at risk".
 */
export function accountStanding(input: {
    readonly suspended: boolean;
    /** Reports upheld against them inside the window. */
    readonly upheld: number;
}): AccountStanding {
    if (input.suspended) return "suspended";
    if (input.upheld <= 0) return "good";
    if (input.upheld === 1) return "limited";
    if (input.upheld === 2) return "veryLimited";
    return "atRisk";
}

/** Where a step sits on the ladder, which is what tells the marks before it from
 *  the marks after it. */
export function standingIndex(standing: AccountStanding): number {
    return ACCOUNT_STANDINGS.indexOf(standing);
}
