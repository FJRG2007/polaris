/**
 * The three things an account can do to itself, and the queue two of them land
 * in.
 *
 * Pure: the words, the waits and the shapes, with nothing behind them. The
 * screens that draw these have to know what a lockdown is called and how long a
 * deletion waits without pulling a service - and a test about the ladder should
 * not need a database to ask it a question.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Lockdown
// ---------------------------------------------------------------------------

/**
 * How long a note explaining a lockdown may be.
 *
 * Enough for what happened and no more. Somebody presses this switch while they
 * are frightened; a form that demands a page is a switch that does not get
 * pressed.
 */
export const MAX_LOCKDOWN_NOTE = 500;

/** What lockdown actually stops, in the order it matters to the person reading
 *  it. Drawn on the card, so the promise is stated rather than implied. */
export const LOCKDOWN_EFFECTS: readonly string[] = [
    "Nothing about how your account is protected can be changed - not the password, not the second step, not a passkey, not a connected account.",
    "No new sign-in works, however correct the password is.",
    "The devices already signed in keep working, so you do not lock yourself out of lifting it.",
    "An administrator is told, and looks at the account."
];

export const lockdownSchema = z.object({
    note: z.string().trim().max(MAX_LOCKDOWN_NOTE).default("")
});

// ---------------------------------------------------------------------------
// Switching off, and deleting
// ---------------------------------------------------------------------------

/**
 * How long a deleted account waits before anything is actually removed.
 *
 * Thirty days, which is what everybody else does and what people therefore
 * expect. The account somebody deletes in anger on a Friday is the account they
 * want back on Monday.
 */
export const DELETION_GRACE_DAYS = 30;

/** The two ways an account stops being available, as the account itself asked. */
export const ACCOUNT_CLOSURES = ["disabled", "deleting"] as const;

export type AccountClosure = (typeof ACCOUNT_CLOSURES)[number];

export const ACCOUNT_CLOSURE_LABELS: Record<AccountClosure, string> = {
    disabled: "Switched off",
    deleting: "Waiting to be deleted"
};

/** Days left of a wait that started at `since`, floored at zero. Pure so a
 *  screen and a sweep read the same number. */
export function daysLeft(since: Date, now: Date, graceDays = DELETION_GRACE_DAYS): number {
    const ends = since.getTime() + graceDays * 24 * 60 * 60 * 1000;
    return Math.max(0, Math.ceil((ends - now.getTime()) / (24 * 60 * 60 * 1000)));
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** What a case on the safety queue is about. */
export const SAFETY_CASE_KINDS = ["lockdown", "user"] as const;

export type SafetyCaseKind = (typeof SAFETY_CASE_KINDS)[number];

export const SAFETY_CASE_KIND_LABELS: Record<SafetyCaseKind, string> = {
    lockdown: "Account locked down",
    user: "Reported account"
};

export const SAFETY_CASE_STATUSES = ["open", "resolved", "dismissed"] as const;

export type SafetyCaseStatus = (typeof SAFETY_CASE_STATUSES)[number];

export const SAFETY_CASE_STATUS_LABELS: Record<SafetyCaseStatus, string> = {
    open: "Open",
    resolved: "Resolved",
    dismissed: "Dismissed"
};

/**
 * Why somebody reported a person.
 *
 * The same list the message reports use, minus the ones that only make sense
 * about a single message. Reporting a person is a statement about a pattern.
 */
export const USER_REPORT_REASONS = [
    "spam",
    "abuse",
    "impersonation",
    "sexual",
    "illegal",
    "other"
] as const;

export type UserReportReason = (typeof USER_REPORT_REASONS)[number];

export const USER_REPORT_REASON_LABELS: Record<UserReportReason, string> = {
    spam: "Spam or scams",
    abuse: "Harassment or abuse",
    impersonation: "Pretending to be somebody else",
    sexual: "Sexual content",
    illegal: "Something illegal",
    other: "Something else"
};

/** How much somebody may write about a report. Long enough to describe a
 *  pattern, which is what a report about a person is. */
export const MAX_REPORT_NOTE = 1000;

export const userReportSchema = z.object({
    subjectId: z.string().uuid(),
    reason: z.enum(USER_REPORT_REASONS),
    note: z.string().trim().max(MAX_REPORT_NOTE).default("")
});

export type UserReportInput = z.infer<typeof userReportSchema>;

export const settleCaseSchema = z.object({
    caseId: z.string().uuid(),
    status: z.enum(["resolved", "dismissed"]),
    outcome: z.string().trim().max(MAX_REPORT_NOTE).default("")
});

export type SettleCaseInput = z.infer<typeof settleCaseSchema>;
