/**
 * Which pull requests the repository bot reviews on its own.
 *
 * A review that starts by itself is the bot spending the operator's credits on
 * somebody else's say-so, so the operator narrows it: drafts or not, which base
 * branches, which labels, titles and authors keep it away, and whether new pushes
 * to a pull request already reviewed are reviewed again. A person who asks for a
 * review by name, or mentions the app, is never filtered by those - that is
 * somebody asking, not Polaris deciding. Who may ask is its own set of fields:
 * whether strangers on a public repository can, who is never answered, how many
 * mentions an hour a repository answers, and whether a reply to the bot's own
 * review comment counts as asking.
 *
 * Settings come in tiers exactly like Enigma's: the repository, then the GitHub
 * account it belongs to, then the person's general tier, then the instance. Every
 * field is nullable and null means "ask the tier above"; the nearest tier with an
 * opinion wins it. Lists are answers, not additions - a repository that lists its
 * own labels means those labels, not those plus the organization's.
 *
 * The same settings can live in the repository itself, in `.polaris/review.yaml`,
 * read from the default branch or from the pull request's own branch. Whichever
 * tier picks that source, the file then outranks every saved tier for the fields
 * it sets, the way a `.coderabbit.yaml` does.
 */

import { z } from "zod";

/** Where a repository's review settings are read from. */
export const REVIEW_CONFIG_SOURCES = ["saved", "repo", "branch"] as const;
export type ReviewConfigSource = (typeof REVIEW_CONFIG_SOURCES)[number];

/** The file a repository keeps its review settings in. */
export const REVIEW_CONFIG_PATH = ".polaris/review.yaml";

/** The most entries one list takes, and the longest one entry may be. */
export const REVIEW_LIST_MAX = 50;
const ENTRY_MAX = 100;

/** The most pushes in a row a pull request is reviewed for before the bot
 *  stops and waits to be asked. */
export const REVIEW_PAUSE_MAX = 100;

/** The highest hourly mention limit a repository can set. */
export const MENTIONS_PER_HOUR_MAX = 1000;

export interface ReviewSettings {
    /** Review a pull request while it is still a draft. */
    readonly drafts: boolean | null;
    /** Base branches a pull request has to target, as globs (`release/*`).
     *  Empty is every branch. */
    readonly baseBranches: string[] | null;
    /** Labels a pull request needs one of; a `!` in front excludes it instead.
     *  Empty is no narrowing. */
    readonly labels: string[] | null;
    /** Words that keep a pull request out when its title contains one, in any
     *  case (`WIP`, `do not merge`). */
    readonly ignoreTitleKeywords: string[] | null;
    /** GitHub logins whose pull requests are never reviewed on their own -
     *  usually bots that open them by the dozen. */
    readonly ignoreAuthors: string[] | null;
    /** Review again when new commits are pushed to a pull request. */
    readonly incremental: boolean | null;
    /** After this many reviews of new pushes on one pull request the bot stops
     *  and waits to be asked. Zero never stops. */
    readonly pauseAfter: number | null;
    readonly configSource: ReviewConfigSource | null;
    /** On a public repository, answer mentions from people who cannot write to
     *  it. Off keeps a stranger from spending the operator's credits. */
    readonly mentionsFromAnyone: boolean | null;
    /** GitHub logins whose mentions are never answered. */
    readonly ignoreMentionsFrom: string[] | null;
    /** A reply to one of the bot's own review comments is answered without
     *  naming it, the way a reviewer answers a thread. */
    readonly autoReply: boolean | null;
    /** The most mentions a repository answers in an hour. Zero is no limit. */
    readonly mentionsPerHour: number | null;
}

/** Nothing decided at this tier. */
export const INHERIT_REVIEW: ReviewSettings = {
    drafts: null,
    baseBranches: null,
    labels: null,
    ignoreTitleKeywords: null,
    ignoreAuthors: null,
    incremental: null,
    pauseAfter: null,
    configSource: null,
    mentionsFromAnyone: null,
    ignoreMentionsFrom: null,
    autoReply: null,
    mentionsPerHour: null
};

/**
 * Every field decided. New pushes are not reviewed unless somebody turns it on:
 * that was the behaviour before these settings existed, and a repository that
 * suddenly reviewed every push would be a bill nobody agreed to.
 */
export const DEFAULT_REVIEW: ResolvedReview = {
    drafts: false,
    baseBranches: [],
    labels: [],
    ignoreTitleKeywords: [],
    ignoreAuthors: [],
    incremental: false,
    pauseAfter: 5,
    configSource: "saved",
    mentionsFromAnyone: false,
    ignoreMentionsFrom: [],
    autoReply: false,
    mentionsPerHour: 0
};

export type ResolvedReview = {
    readonly [K in keyof ReviewSettings]: NonNullable<ReviewSettings[K]>;
};

const entry = z.string().trim().min(1).max(ENTRY_MAX);
const list = z.array(entry).max(REVIEW_LIST_MAX);

/** One tier as the form sends it. */
export const reviewSettingsSchema = z.object({
    drafts: z.boolean().nullable().default(null),
    baseBranches: list.nullable().default(null),
    labels: list.nullable().default(null),
    ignoreTitleKeywords: list.nullable().default(null),
    ignoreAuthors: list.nullable().default(null),
    incremental: z.boolean().nullable().default(null),
    pauseAfter: z.number().int().min(0).max(REVIEW_PAUSE_MAX).nullable().default(null),
    configSource: z.enum(REVIEW_CONFIG_SOURCES).nullable().default(null),
    mentionsFromAnyone: z.boolean().nullable().default(null),
    ignoreMentionsFrom: list.nullable().default(null),
    autoReply: z.boolean().nullable().default(null),
    mentionsPerHour: z.number().int().min(0).max(MENTIONS_PER_HOUR_MAX).nullable().default(null)
});

/**
 * The repository's own file, in the names people write YAML in. Unknown keys are
 * ignored rather than refused, so a file written for a newer Polaris still
 * applies what this one understands.
 */
const reviewFileSchema = z
    .object({
        drafts: z.boolean().optional(),
        base_branches: list.optional(),
        labels: list.optional(),
        ignore_title_keywords: list.optional(),
        ignore_authors: list.optional(),
        incremental: z.boolean().optional(),
        pause_after: z.number().int().min(0).max(REVIEW_PAUSE_MAX).optional(),
        mentions_from_anyone: z.boolean().optional(),
        ignore_mentions_from: list.optional(),
        auto_reply: z.boolean().optional(),
        mentions_per_hour: z.number().int().min(0).max(MENTIONS_PER_HOUR_MAX).optional()
    })
    .passthrough();

/** The settings a parsed `.polaris/review.yaml` holds, or null when the file is
 *  not a mapping this build can read. A file never chooses its own source. */
export function reviewSettingsFromFile(parsed: unknown): ReviewSettings | null {
    const root =
        parsed && typeof parsed === "object" && "reviews" in parsed
            ? (parsed as { reviews: unknown }).reviews
            : parsed;
    const result = reviewFileSchema.safeParse(root ?? {});
    if (!result.success) return null;
    const file = result.data;
    return {
        drafts: file.drafts ?? null,
        baseBranches: file.base_branches ?? null,
        labels: file.labels ?? null,
        ignoreTitleKeywords: file.ignore_title_keywords ?? null,
        ignoreAuthors: file.ignore_authors ?? null,
        incremental: file.incremental ?? null,
        pauseAfter: file.pause_after ?? null,
        configSource: null,
        mentionsFromAnyone: file.mentions_from_anyone ?? null,
        ignoreMentionsFrom: file.ignore_mentions_from ?? null,
        autoReply: file.auto_reply ?? null,
        mentionsPerHour: file.mentions_per_hour ?? null
    };
}

/** Fold tiers into one answer, nearest first. */
export function resolveReview(
    ...tiers: readonly (ReviewSettings | null | undefined)[]
): ResolvedReview {
    const present = tiers.filter((tier): tier is ReviewSettings => Boolean(tier));
    const pick = <K extends keyof ReviewSettings>(key: K): ResolvedReview[K] => {
        for (const tier of present) {
            const value = tier[key];
            if (value !== null && value !== undefined) return value as ResolvedReview[K];
        }
        return DEFAULT_REVIEW[key];
    };
    return {
        drafts: pick("drafts"),
        baseBranches: pick("baseBranches"),
        labels: pick("labels"),
        ignoreTitleKeywords: pick("ignoreTitleKeywords"),
        ignoreAuthors: pick("ignoreAuthors"),
        incremental: pick("incremental"),
        pauseAfter: pick("pauseAfter"),
        configSource: pick("configSource"),
        mentionsFromAnyone: pick("mentionsFromAnyone"),
        ignoreMentionsFrom: pick("ignoreMentionsFrom"),
        autoReply: pick("autoReply"),
        mentionsPerHour: pick("mentionsPerHour")
    };
}

/**
 * Read a stored settings column back. Anything unrecognised becomes null -
 * inherit - because a value this build cannot read is not its to answer.
 */
export function parseReviewSettings(raw: string | null | undefined): ReviewSettings {
    if (!raw) return INHERIT_REVIEW;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return INHERIT_REVIEW;
    }
    if (!parsed || typeof parsed !== "object") return INHERIT_REVIEW;
    const record = parsed as Record<string, unknown>;
    const field = <K extends keyof ReviewSettings>(key: K): ReviewSettings[K] => {
        const one = reviewSettingsSchema.shape[key].safeParse(record[key]);
        return (one.success ? one.data : null) as ReviewSettings[K];
    };
    return {
        drafts: field("drafts"),
        baseBranches: field("baseBranches"),
        labels: field("labels"),
        ignoreTitleKeywords: field("ignoreTitleKeywords"),
        ignoreAuthors: field("ignoreAuthors"),
        incremental: field("incremental"),
        pauseAfter: field("pauseAfter"),
        configSource: field("configSource"),
        mentionsFromAnyone: field("mentionsFromAnyone"),
        ignoreMentionsFrom: field("ignoreMentionsFrom"),
        autoReply: field("autoReply"),
        mentionsPerHour: field("mentionsPerHour")
    };
}

/** Whether a tier decides anything, so an empty one is stored as nothing. */
export function reviewSettingsEmpty(settings: ReviewSettings | null | undefined): boolean {
    return !settings || Object.values(settings).every((value) => value === null);
}

/**
 * Whether a branch matches a glob. `*` is any run of characters other than `/`,
 * `**` any run at all; everything else is literal. Built by hand rather than as
 * a regular expression from the pattern, so an operator's pattern can never be
 * one that takes the webhook down.
 */
export function branchMatches(pattern: string, branch: string): boolean {
    const p = pattern.trim();
    let pi = 0;
    let bi = 0;
    let starP = -1;
    let starB = 0;
    let deep = false;
    while (bi < branch.length) {
        if (p.startsWith("**", pi)) {
            starP = pi + 2;
            starB = bi;
            deep = true;
            pi += 2;
        } else if (p[pi] === "*") {
            starP = pi + 1;
            starB = bi;
            deep = false;
            pi += 1;
        } else if (pi < p.length && p[pi] === branch[bi]) {
            pi += 1;
            bi += 1;
        } else if (starP !== -1 && (deep || branch[starB] !== "/")) {
            starB += 1;
            bi = starB;
            pi = starP;
        } else {
            return false;
        }
    }
    while (p[pi] === "*") pi += 1;
    return pi === p.length;
}

/** What the pull request looks like, as far as the filters care. */
export interface ReviewCandidate {
    readonly draft: boolean;
    readonly title: string;
    readonly author: string;
    readonly baseBranch: string | null;
    readonly labels: readonly string[];
}

/** Why a pull request is left alone, or null when it is reviewed. */
export type ReviewSkip = "draft" | "branch" | "label" | "title" | "author";

/**
 * Whether the bot reviews this pull request on its own. Pure, so every rule the
 * screen describes is asserted in a test rather than trusted.
 */
export function reviewSkip(settings: ResolvedReview, pr: ReviewCandidate): ReviewSkip | null {
    if (pr.draft && !settings.drafts) return "draft";
    const author = pr.author.toLowerCase();
    if (settings.ignoreAuthors.some((login) => login.toLowerCase() === author)) return "author";
    const title = pr.title.toLowerCase();
    if (settings.ignoreTitleKeywords.some((word) => title.includes(word.toLowerCase())))
        return "title";
    if (
        settings.baseBranches.length > 0 &&
        !(pr.baseBranch && settings.baseBranches.some((glob) => branchMatches(glob, pr.baseBranch!)))
    )
        return "branch";
    const has = new Set(pr.labels.map((label) => label.toLowerCase()));
    const excluded = settings.labels
        .filter((label) => label.startsWith("!"))
        .map((label) => label.slice(1).toLowerCase());
    if (excluded.some((label) => has.has(label))) return "label";
    const wanted = settings.labels
        .filter((label) => !label.startsWith("!"))
        .map((label) => label.toLowerCase());
    if (wanted.length > 0 && !wanted.some((label) => has.has(label))) return "label";
    return null;
}

/** Why a mention is not answered, or null when it is. */
export type MentionRefusal = "ignored" | "stranger" | "limit";

/**
 * Whether a mention is answered. Pure: the caller asks GitHub whether the person
 * can write and counts the hour's mentions, and only when the answer matters.
 */
export function mentionRefusal(
    settings: ResolvedReview,
    mention: {
        readonly actor: string;
        readonly publicRepo: boolean;
        /** Null when it was not asked because it could not change the answer. */
        readonly canWrite: boolean | null;
        readonly answeredThisHour: number;
    }
): MentionRefusal | null {
    const actor = mention.actor.toLowerCase();
    if (settings.ignoreMentionsFrom.some((login) => login.toLowerCase() === actor)) return "ignored";
    if (mention.publicRepo && !settings.mentionsFromAnyone && mention.canWrite !== true) return "stranger";
    if (settings.mentionsPerHour > 0 && mention.answeredThisHour >= settings.mentionsPerHour) return "limit";
    return null;
}
