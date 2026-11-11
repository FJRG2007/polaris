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

/** How severe a failed pre-merge check is: not run, a note, or a request for
 *  changes. */
export const REVIEW_CHECK_LEVELS = ["off", "warning", "error"] as const;
export type ReviewCheckLevel = (typeof REVIEW_CHECK_LEVELS)[number];

/** How hard the review pushes: the runtime's own balance, only what matters,
 *  or everything worth saying. */
export const REVIEW_PROFILES = ["default", "chill", "assertive"] as const;
export type ReviewProfile = (typeof REVIEW_PROFILES)[number];

/** The longest piece of operator prose one instruction may be. */
export const REVIEW_PROSE_MAX = 2000;

const entry = z.string().trim().min(1).max(ENTRY_MAX);
const list = z.array(entry).max(REVIEW_LIST_MAX);
const prose = z.string().trim().max(REVIEW_PROSE_MAX);
const named = z.object({ name: entry, instructions: prose.min(1) });
const level = z.enum(REVIEW_CHECK_LEVELS);
const nullable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().default(null);

/** A row with a blank text field is one the form is still holding while it is
 *  typed, not an entry: it is dropped rather than refusing the whole tier. */
function complete(row: unknown): boolean {
    if (!row || typeof row !== "object") return true;
    return Object.values(row).every((value) => typeof value !== "string" || value.trim() !== "");
}
const rows = <T extends z.ZodTypeAny>(row: T) =>
    z.preprocess(
        (value) => (Array.isArray(value) ? value.filter(complete) : value),
        z.array(row).max(REVIEW_LIST_MAX)
    );

/**
 * One tier as the form sends it, and the single list of every setting: the
 * types, the stored column, the repository file and the resolver all read
 * their keys from here, so a field added once is a field everywhere.
 */
export const reviewSettingsSchema = z.object({
    /** Review a pull request while it is still a draft. */
    drafts: nullable(z.boolean()),
    /** Base branches a pull request has to target, as globs. Empty is every branch. */
    baseBranches: nullable(list),
    /** Labels a pull request needs one of; `!` in front excludes it instead. */
    labels: nullable(list),
    /** Words that keep a pull request out when its title contains one. */
    ignoreTitleKeywords: nullable(list),
    /** GitHub logins whose pull requests are never reviewed on their own. */
    ignoreAuthors: nullable(list),
    /** Review again when new commits are pushed to a pull request. */
    incremental: nullable(z.boolean()),
    /** After this many reviews of new pushes on one pull request the bot stops
     *  and waits to be asked. Zero never stops. */
    pauseAfter: nullable(z.number().int().min(0).max(REVIEW_PAUSE_MAX)),
    configSource: nullable(z.enum(REVIEW_CONFIG_SOURCES)),
    /** On a public repository, answer mentions from people who cannot write. */
    mentionsFromAnyone: nullable(z.boolean()),
    /** GitHub logins whose mentions are never answered. */
    ignoreMentionsFrom: nullable(list),
    /** Answer a reply to one of the bot's own review comments without a mention. */
    autoReply: nullable(z.boolean()),
    /** The most mentions a repository answers in an hour. Zero is no limit. */
    mentionsPerHour: nullable(z.number().int().min(0).max(MENTIONS_PER_HOUR_MAX)),

    // What the review says. Every default is the runtime's own behaviour, so a
    // tier that sets none of these reviews exactly as before.
    profile: nullable(z.enum(REVIEW_PROFILES)),
    /** Free prose on how to phrase the review (language, tone, length). */
    tone: nullable(prose),
    /** Write a summary of the change into the pull request description. */
    describePr: nullable(z.boolean()),
    /** A walkthrough of the change, file group by file group, in the review. */
    walkthrough: nullable(z.boolean()),
    /** That walkthrough folded away until opened. */
    collapseWalkthrough: nullable(z.boolean()),
    /** A table of the changed files and what changed in each. */
    changedFiles: nullable(z.boolean()),
    /** Mermaid sequence diagrams for changed control flow. */
    sequenceDiagrams: nullable(z.boolean()),
    /** An estimate of how much effort reviewing the change takes. */
    effortEstimate: nullable(z.boolean()),
    /** Whether the change does what its linked issues ask. */
    linkedIssues: nullable(z.boolean()),
    /** Suggest labels for the pull request; apply them when `applyLabels`. */
    suggestLabels: nullable(z.boolean()),
    applyLabels: nullable(z.boolean()),
    /** Suggest who should review, from who owns and last changed the code. */
    suggestReviewers: nullable(z.boolean()),
    /** Pre-merge checks, each off, a warning, or an error. */
    titleCheck: nullable(level),
    descriptionCheck: nullable(level),
    issueCheck: nullable(level),
    docstringCheck: nullable(level),
    /** The share of new public functions that should be documented. */
    docstringThreshold: nullable(z.number().int().min(0).max(100)),
    /** The operator's own checks, each a name, what passing means, and a level. */
    customChecks: nullable(rows(named.extend({ level }))),
    /** Extra instructions for files matching a glob. */
    pathInstructions: nullable(rows(z.object({ path: entry, instructions: prose.min(1) }))),
    /** Files the review leaves out, as globs (`dist/**`, `*.lock`). */
    pathFilters: nullable(list),
    /** Named jobs anyone allowed to mention the app can ask for by name. */
    recipes: nullable(rows(named))
});

type ReviewShape = z.infer<typeof reviewSettingsSchema>;

/** One tier: every field nullable, null meaning "ask the tier above". */
export type ReviewSettings = { readonly [K in keyof ReviewShape]: ReviewShape[K] };

export type ResolvedReview = {
    readonly [K in keyof ReviewSettings]: NonNullable<ReviewSettings[K]>;
};

type ReviewKey = keyof ReviewSettings;
const REVIEW_KEYS = Object.keys(reviewSettingsSchema.shape) as ReviewKey[];

/** Nothing decided at this tier. */
export const INHERIT_REVIEW: ReviewSettings = Object.fromEntries(
    REVIEW_KEYS.map((key) => [key, null])
) as unknown as ReviewSettings;

/**
 * Every field decided. New pushes are not reviewed unless somebody turns it on:
 * that was the behaviour before these settings existed, and a repository that
 * suddenly reviewed every push would be a bill nobody agreed to. Every output
 * extra is off for the same reason.
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
    mentionsPerHour: 0,
    profile: "default",
    tone: "",
    describePr: false,
    walkthrough: false,
    collapseWalkthrough: false,
    changedFiles: false,
    sequenceDiagrams: false,
    effortEstimate: false,
    linkedIssues: false,
    suggestLabels: false,
    applyLabels: false,
    suggestReviewers: false,
    titleCheck: "off",
    descriptionCheck: "off",
    issueCheck: "off",
    docstringCheck: "off",
    docstringThreshold: 80,
    customChecks: [],
    pathInstructions: [],
    pathFilters: [],
    recipes: []
};

/** `ignoreTitleKeywords` -> `ignore_title_keywords`, the name YAML files use. */
function snake(key: string): string {
    return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * The settings a parsed `.polaris/review.yaml` holds, in the names people
 * write YAML in, at the top or under `reviews:`. Unknown keys are ignored so a
 * file written for a newer Polaris still applies what this one understands; a
 * known key with a wrong value makes the whole file unreadable, so a typo is
 * noticed rather than half-applied. A file never chooses its own source.
 */
export function reviewSettingsFromFile(parsed: unknown): ReviewSettings | null {
    const root =
        parsed && typeof parsed === "object" && "reviews" in parsed
            ? (parsed as { reviews: unknown }).reviews
            : (parsed ?? {});
    if (!root || typeof root !== "object" || Array.isArray(root)) return null;
    const record = root as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of REVIEW_KEYS) {
        const name = snake(key);
        if (key === "configSource" || !(name in record)) {
            out[key] = null;
            continue;
        }
        const one = reviewSettingsSchema.shape[key].safeParse(record[name]);
        if (!one.success || one.data === null) return null;
        out[key] = one.data;
    }
    return out as unknown as ReviewSettings;
}

/** Fold tiers into one answer, nearest first. Lists are answers, not additions. */
export function resolveReview(
    ...tiers: readonly (ReviewSettings | null | undefined)[]
): ResolvedReview {
    const present = tiers.filter((tier): tier is ReviewSettings => Boolean(tier));
    const out: Record<string, unknown> = {};
    for (const key of REVIEW_KEYS) {
        const found = present.find((tier) => tier[key] !== null && tier[key] !== undefined);
        out[key] = found ? found[key] : DEFAULT_REVIEW[key];
    }
    return out as unknown as ResolvedReview;
}

/**
 * Read a stored settings column back. Anything unrecognised becomes null -
 * inherit - because a value this build cannot read is not its to answer. Each
 * field is read on its own, so one bad value never costs the others.
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
    return Object.fromEntries(
        REVIEW_KEYS.map((key) => {
            const one = reviewSettingsSchema.shape[key].safeParse(record[key]);
            return [key, one.success ? one.data : null];
        })
    ) as unknown as ReviewSettings;
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

const CHECK_NAMES = {
    titleCheck: "Title: the pull request title says what the change does, in the repository's convention.",
    descriptionCheck: "Description: the pull request description explains what changed and why.",
    issueCheck: "Linked issue: the pull request links the issue it resolves, and does what that issue asks."
} as const;

/** One pre-merge check's line, worded by how much a failure counts. */
function checkLine(text: string, level: ReviewCheckLevel): string {
    return level === "error"
        ? `- ${text} If it fails, request changes and say so under "Pre-merge checks".`
        : `- ${text} If it fails, say so under "Pre-merge checks" as a warning; it does not block.`;
}

/**
 * What the operator asked a review to contain, as instructions for the
 * runtime's Review mode (incremental reviews inherit them). Empty when every
 * setting is at its default, so a repository nobody configured reviews exactly
 * as before. Pure, so the wording is asserted in a test.
 */
export function reviewInstructions(settings: ResolvedReview): string {
    const lines: string[] = [];
    if (settings.profile === "chill")
        lines.push("- Keep the review to what matters: bugs, security, data loss, broken contracts. Skip style nitpicks.");
    if (settings.profile === "assertive")
        lines.push("- Be thorough: besides defects, point out style, naming, missing tests and simpler alternatives, as nitpicks.");
    if (settings.tone) lines.push(`- How to write the review, in the operator's words: ${settings.tone}`);
    if (settings.describePr)
        lines.push(
            "- Add a short summary of the change to the pull request description with `update_pull_request_body`, under a `## Summary` heading, keeping everything the author wrote."
        );
    if (settings.walkthrough)
        lines.push(
            settings.collapseWalkthrough
                ? "- Include a walkthrough of the change grouped by area, inside a `<details><summary>Walkthrough</summary>` block."
                : "- Include a `### Walkthrough` section that walks through the change grouped by area."
        );
    if (settings.changedFiles) lines.push("- Include a table of the changed files with one line on what changed in each.");
    if (settings.sequenceDiagrams)
        lines.push("- Where the change alters a control flow between components, include a Mermaid `sequenceDiagram` of it.");
    if (settings.effortEstimate)
        lines.push("- Estimate the effort to review this change on a 1-5 scale with the rough minutes it takes, and why.");
    if (settings.linkedIssues)
        lines.push("- Read the issues the pull request links and say, per issue, whether the change does what it asks.");
    if (settings.suggestLabels)
        lines.push(
            settings.applyLabels
                ? "- Pick labels from the repository's existing labels that fit the change and apply them with `add_labels`. Never create new labels."
                : "- Suggest labels from the repository's existing labels that fit the change, in a `### Suggested labels` line. Do not apply them."
        );
    if (settings.suggestReviewers)
        lines.push(
            "- Suggest up to three reviewers from the people who own or most recently changed the touched code (CODEOWNERS, git history), in a `### Suggested reviewers` line. Never the author."
        );
    const checks: string[] = [];
    for (const key of ["titleCheck", "descriptionCheck", "issueCheck"] as const)
        if (settings[key] !== "off") checks.push(checkLine(CHECK_NAMES[key], settings[key]));
    if (settings.docstringCheck !== "off")
        checks.push(
            checkLine(
                `Docstrings: at least ${settings.docstringThreshold}% of the public functions and classes this change adds are documented.`,
                settings.docstringCheck
            )
        );
    for (const check of settings.customChecks)
        if (check.level !== "off") checks.push(checkLine(`${check.name}: ${check.instructions}`, check.level));
    if (checks.length > 0)
        lines.push("- Run these pre-merge checks and report each as passed or failed in a `### Pre-merge checks` section:", ...checks.map((line) => `  ${line}`));
    if (settings.pathFilters.length > 0)
        lines.push(`- Leave files matching these globs out of the review: ${settings.pathFilters.map((glob) => `\`${glob}\``).join(", ")}.`);
    for (const rule of settings.pathInstructions)
        lines.push(`- For files matching \`${rule.path}\`: ${rule.instructions}`);
    return lines.length === 0 ? "" : ["The operator configured this review:", ...lines].join("\n");
}

/**
 * The named jobs people can ask for, as standing guidance for every mode.
 * Empty when there are none.
 */
export function recipeInstructions(settings: ResolvedReview): string {
    if (settings.recipes.length === 0) return "";
    return [
        "When somebody who mentions you asks for one of these by name, do what it says:",
        ...settings.recipes.map((recipe) => `- "${recipe.name}": ${recipe.instructions}`)
    ].join("\n");
}
