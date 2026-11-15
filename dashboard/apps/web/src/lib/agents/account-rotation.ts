/**
 * A session's agent hit a usage limit: it moves to the next of its owner's
 * accounts for that tool and carries on, instead of stopping on a failed turn.
 *
 * The technique is Enigma's local API rotation (`enigma api --rotation`,
 * `api-rotation.ts`), which follows OmniRoute's account-level backoff: a limit
 * cools the account until the reset the tool reported, else 2 minutes doubling
 * per repeat up to 30; the request reruns on the next account; an overloaded
 * provider (529) is deliberately not a reason to rotate, since every account
 * would meet the same overload. Here the "request" is the turn that failed,
 * sent again once on the new account.
 *
 * The cooling is written on the account row the way Polar's router and
 * `signin-refusal.ts` write theirs (`UserModelKey.coolingUntil`, reason
 * `rate`), so the keys screen shows "Cooling down" with the time it ends.
 *
 * Race-safe by a conditional update on the session row: the claim only lands
 * while the row still holds the account, hook sequence and wait it was read
 * with, so two copies of one failure move the session once.
 *
 * A session can also be moved by hand (`switchSessionAccount`), the way AO's
 * `ao account switch` pins a session to another account: the same claim on
 * the row, the launch reads the new account before the next turn, and an
 * agent that left its terminal is brought back on its conversation.
 * Ported from Agent Orchestrator (Apache-2.0),
 * backend/internal/service/agentaccounts/service.go (session handoff).
 *
 * Server-only apart from the pure readers.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { queueTurnAgain } from "@/lib/agents/session-runtime";
import { instanceKeysAreShared } from "@/lib/agents/model-keys";
import { refusedAccountName } from "@/lib/agents/signin-refusal";
import { addSessionMessage } from "@/lib/agents/session-service";
import { agentSignins, signinSlug } from "@/lib/agents/agent-signins";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Enigma's backoff when the tool names no reset: 2 min doubling, at most 30. */
export const LIMIT_BASE_MS = 2 * MINUTE;
export const LIMIT_MOST_MS = 30 * MINUTE;
/** The furthest a reported reset is believed. A weekly limit is real; a date
 *  a month out is a misread. */
const RESET_MOST_MS = 8 * 24 * HOUR;
/** How many times an overloaded turn is sent again, and the first wait. */
export const OVERLOAD_RETRIES = 2;
export const OVERLOAD_WAIT_MS = 30 * SECOND;
/** Refusals that do not end on their own: never "the first to free up". */
const STAYS_OUT = new Set(["key", "credit", "paid"]);

export type LimitKind = "rate_limit" | "overloaded" | "other";

export interface LimitReading {
    readonly kind: LimitKind;
    /** When the account is usable again, as the tool said, in epoch ms. */
    readonly resetAt: number | null;
}

/** What a failed turn's hook said: the error type and the words around it. */
export interface TurnFailure {
    readonly error: string;
    readonly text: string;
}

// ---------------------------------------------------------------------------
// Classifier (pure)
// ---------------------------------------------------------------------------

/** Error types a hook names outright. Claude Code's StopFailure `error` field
 *  (code.claude.com/docs/en/hooks, "StopFailure input"): `rate_limit`,
 *  `overloaded`, and the rest, which are not limits. */
const TYPED: Readonly<Record<string, LimitKind>> = {
    rate_limit: "rate_limit",
    overloaded: "overloaded"
};

/** Overload wording, checked before limits: a provider busy for everyone. */
const OVERLOADED: readonly RegExp[] = [
    // Anthropic API error type for HTTP 529 (docs.anthropic.com errors page).
    /overloaded_error/i,
    // Claude Code's rendered error for a 529 ("API Error: 529 ...").
    /api error: 529\b/i,
    // Codex: `CodexErr::ServerOverloaded` (codex-rs/protocol/src/error.rs).
    /selected model is at capacity/i,
    // Gemini API 503 body, quoted in gemini-cli
    // packages/core/src/telemetry/loggers.test.ts.
    /the model is overloaded/i
];

/** Usage-limit wording. */
const LIMITED: readonly RegExp[] = [
    // Claude Code: "You've hit your limit · resets 11am (America/Chicago)",
    // "You've hit your session limit", "...weekly limit", "...5-hour limit"
    // (anthropics/claude-code issues #38802, #20936 and their titles).
    // Codex: "You've hit your usage limit." (codex-rs/protocol/src/error.rs).
    // Both print a typographic apostrophe as often as a plain one.
    /you['’]ve hit your (?:[\w-]+ )?limit/i,
    // Claude Code's older form, "Claude AI usage limit reached|<epoch>", and
    // "5-hour limit reached" (Enigma api-rotation.ts LIMIT_RE comment).
    /usage limit reached/i,
    /\blimit reached\b/i,
    // Anthropic API error type for HTTP 429 (docs.anthropic.com errors page).
    /rate_limit_error/i,
    // Claude Code's StopFailure example: last_assistant_message
    // "API Error: Rate limit reached", error_details "429 Too Many Requests".
    /api error: rate limit reached/i,
    /\b429 too many requests\b/i,
    // Gemini API 429 bodies, quoted in gemini-cli
    // packages/core/src/utils/googleQuotaErrors.test.ts.
    /you exceeded your current quota/i,
    /quota exceeded for metric/i,
    /\bRESOURCE_EXHAUSTED\b/
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The zone's offset from UTC at an instant, in ms. Throws on a zone the
 *  runtime does not know. */
function offsetOf(at: number, zone: string): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric"
    }).formatToParts(new Date(at));
    const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
    const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    return wall - Math.floor(at / SECOND) * SECOND;
}

/** A wall-clock time in a zone, as an instant. */
function zoned(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
    const wall = Date.UTC(year, month, day, hour, minute);
    const first = wall - offsetOf(wall, zone);
    const second = wall - offsetOf(first, zone);
    return second;
}

/** The calendar day an instant falls on in a zone. */
function dayIn(at: number, zone: string): { year: number; month: number; day: number } {
    const shifted = new Date(at + offsetOf(at, zone));
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

/** The next time a clock reads `hour:minute` in a zone, after `now`. */
function nextWallTime(hour: number, minute: number, zone: string, now: number): number {
    const { year, month, day } = dayIn(now, zone);
    const today = zoned(year, month, day, hour, minute, zone);
    return today > now ? today : zoned(year, month, day + 1, hour, minute, zone);
}

function hour24(hour: number, meridiem: string): number {
    const pm = meridiem.toLowerCase() === "pm";
    return (hour % 12) + (pm ? 12 : 0);
}

/**
 * When the tool says the limit resets, in epoch ms, or null when it names no
 * time. A zone the runtime does not know, and a time with no zone, are read
 * as UTC: the tools print the machine's local time, and a session container
 * runs in UTC. Pure.
 */
export function resetFromText(text: string, now = Date.now()): number | null {
    let at: number | null = null;
    // Claude Code's older form: "Claude AI usage limit reached|1717000000"
    // (Enigma api-rotation.ts parseResetAt).
    const epoch = /\|(\d{10})(?!\d)/.exec(text);
    if (epoch) at = Number(epoch[1]) * SECOND;
    // Claude Code: "resets 2:40pm (Europe/Istanbul)", "resets 2am",
    // "resets 12:30pm" (anthropics/claude-code issue titles).
    const claude = /resets (\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\))?/i.exec(text);
    if (at === null && claude) {
        const hour = hour24(Number(claude[1]), claude[3]!);
        const minute = Number(claude[2] ?? 0);
        try {
            at = nextWallTime(hour, minute, claude[4] ?? "UTC", now);
        } catch {
            at = nextWallTime(hour, minute, "UTC", now);
        }
    }
    // Codex: " Try again at 3:05 PM." today, or
    // " Try again at Nov 20th, 2026 3:05 PM." (format_retry_timestamp,
    // codex-rs/protocol/src/error.rs).
    const codex = /try again at (?:([A-Za-z]{3}) (\d{1,2})(?:st|nd|rd|th), (\d{4}) )?(\d{1,2}):(\d{2}) (AM|PM)/i.exec(text);
    if (at === null && codex) {
        const hour = hour24(Number(codex[4]), codex[6]!);
        const minute = Number(codex[5]);
        const month = codex[1] ? MONTHS.indexOf(codex[1].toLowerCase()) : -1;
        at = codex[1] && month >= 0
            ? Date.UTC(Number(codex[3]), month, Number(codex[2]), hour, minute)
            : nextWallTime(hour, minute, "UTC", now);
    }
    // Gemini API: "Please retry in 40.025771073s." or "Please retry in 900.2ms."
    // (gemini-cli packages/core/src/utils/googleQuotaErrors.test.ts).
    const gemini = /please retry in (\d+(?:\.\d+)?)(ms|s)\b/i.exec(text);
    if (at === null && gemini) {
        const amount = Number(gemini[1]);
        at = now + Math.ceil(gemini[2]!.toLowerCase() === "ms" ? amount : amount * SECOND);
    }
    if (at === null || !Number.isFinite(at) || at <= now || at - now > RESET_MOST_MS) return null;
    return at;
}

/**
 * Whether a failed turn is a usage limit, an overloaded provider, or anything
 * else, with the reset time when the text gives one. The hook's own error
 * type wins; the words decide when it names none (Codex, Gemini CLI, Copilot
 * and older Claude Code builds). Pure.
 */
export function limitOf(
    failure: { readonly error?: string | null; readonly text?: string | null },
    now = Date.now()
): LimitReading {
    const error = (failure.error ?? "").trim();
    const text = [error, failure.text ?? ""].join(" ");
    const typed = TYPED[error];
    const kind: LimitKind =
        typed ??
        (OVERLOADED.some((pattern) => pattern.test(text))
            ? "overloaded"
            : LIMITED.some((pattern) => pattern.test(text))
              ? "rate_limit"
              : "other");
    return { kind, resetAt: kind === "rate_limit" ? resetFromText(text, now) : null };
}

/** An error as text, whether it came as a string or as `{ message }`. */
function said(value: unknown): string {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "message" in value) {
        const message = (value as { message: unknown }).message;
        return typeof message === "string" ? message : "";
    }
    return "";
}

/**
 * What a failed turn's hook payload says, whole: the event's stored detail is
 * clipped to a line, and the reset time is often past the clip. Claude Code
 * sends `error`, `error_details` and `last_assistant_message` (the rendered
 * error text); Copilot's `errorOccurred` sends `error` as `{ message }`. Pure.
 */
export function failureOf(payload: unknown): TurnFailure {
    if (!payload || typeof payload !== "object") return { error: "", text: "" };
    const record = payload as Record<string, unknown>;
    const error = typeof record.error === "string" ? record.error : "";
    const text = [said(record.error), said(record.error_details), said(record.last_assistant_message), said(record.message)]
        .filter((part) => part !== "" && part !== error)
        .join(" ")
        .slice(0, 4_096);
    return { error, text };
}

// ---------------------------------------------------------------------------
// Cooling and order (pure)
// ---------------------------------------------------------------------------

/** One account a session could sign in with, in its owner's order. */
export interface RotationAccount {
    readonly id: string;
    readonly name: string;
    /** Until when it is out, in epoch ms, or null when ready. */
    readonly coolingUntil: number | null;
    readonly coolingReason: string | null;
}

/** Repeats per account, in-process and bounded, as Enigma keeps them: a
 *  restart only forgets the doubling, and the next limit re-learns it. */
const levels = new Map<string, { level: number; until: number }>();
const LEVELS_MOST = 1024;

/**
 * Until when an account that just hit its limit stays out: the reported reset,
 * else 2 minutes doubling per repeat within half an hour, at most 30 minutes.
 */
export function coolingUntil(accountId: string, resetAt: number | null, now = Date.now()): number {
    const previous = levels.get(accountId);
    const level = previous && previous.until > now - LIMIT_MOST_MS ? previous.level + 1 : 0;
    const until = resetAt && resetAt > now
        ? resetAt
        : now + Math.min(LIMIT_MOST_MS, LIMIT_BASE_MS * 2 ** level);
    levels.delete(accountId);
    levels.set(accountId, { level, until });
    if (levels.size > LEVELS_MOST) levels.delete(levels.keys().next().value!);
    return until;
}

/** Forget the repeats, for tests. */
export function resetCoolingLevels(): void {
    levels.clear();
}

function isOut(account: RotationAccount, now: number): boolean {
    return account.coolingUntil !== null && account.coolingUntil > now;
}

/**
 * The account to move to: the first of the owner's order that is not the one
 * that hit its limit and is neither cooling nor refused. Null when none is.
 * Pure.
 */
export function nextAccount(
    accounts: readonly RotationAccount[],
    currentId: string | null,
    now = Date.now()
): RotationAccount | null {
    return accounts.find((account) => account.id !== currentId && !isOut(account, now)) ?? null;
}

/**
 * The account that frees up first, and when: the earliest cool-down that ends
 * on its own. A refused key or an empty account never does. Null when none
 * will. Pure.
 */
export function firstFree(
    accounts: readonly RotationAccount[],
    now = Date.now()
): { account: RotationAccount; at: number } | null {
    let found: { account: RotationAccount; at: number } | null = null;
    for (const account of accounts) {
        if (!isOut(account, now) || STAYS_OUT.has(account.coolingReason ?? "")) continue;
        if (!found || account.coolingUntil! < found.at) found = { account, at: account.coolingUntil! };
    }
    return found;
}

// ---------------------------------------------------------------------------
// Session notices (English, stored; `knownAgentText` words them)
// ---------------------------------------------------------------------------

/** The quiet line a rotation leaves in the session. Times travel as ISO so the
 *  reader's screen writes them in its own zone and format. Pure. */
export function switchedNotice(to: string, from: string, at: number, reported: boolean): string {
    const when = new Date(at).toISOString();
    return reported
        ? `Switched to ${to} - ${from} hit its limit, resets at ${when}.`
        : `Switched to ${to} - ${from} hit its limit, back in rotation at ${when}.`;
}

/** Every account at its limit: which, and when the first frees up. Pure. */
export function allCoolingNotice(names: readonly string[], first: { name: string; at: number } | null): string {
    const list = names.join(", ");
    return first
        ? `Every account for this agent is at its limit (${list}). The session waits and carries on at ${new Date(first.at).toISOString()} on ${first.name}.`
        : `Every account for this agent is at its limit or refused (${list}). The session waits until one is linked again or put back in rotation.`;
}

/** Carrying on once an account freed up. Pure. */
export function resumedNotice(name: string): string {
    return `Carrying on with ${name} now that its limit has reset.`;
}

/** Somebody moved the session to another account by hand. Pure. */
export function movedNotice(to: string, from: string | null): string {
    return from ? `Moved to ${to} from ${from}.` : `Moved to ${to}.`;
}

/** The turn could not be queued again (no runner, or the agent's interface is
 *  open): the person sends it. */
export const RESEND_YOURSELF = "Send your last message again to carry on.";

/** An overloaded provider, sent again after a wait. Pure. */
export function overloadedNotice(seconds: number): string {
    return `The provider is overloaded. Polaris sends the turn again in ${seconds} seconds.`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** What to call a stored account: the address its sign-in gave, else the name
 *  its owner chose. */
function accountLabel(row: { name: string; config: string }): string {
    try {
        const email = (JSON.parse(row.config) as { email?: unknown }).email;
        if (typeof email === "string" && email) return email;
    } catch {
        // A config that does not parse names nothing; the name does.
    }
    return row.name;
}

/**
 * The accounts a session of this tool could move between, in the owner's
 * order from the AI keys screen: their own first by priority, then the
 * deployment's where it shares them. Narrowed to the provider of the account
 * the session uses, or to the tool's sign-ins when it picked none.
 */
export async function rotationAccounts(
    ownerId: string | null,
    cli: string,
    accountId: string | null
): Promise<RotationAccount[]> {
    const shared = await instanceKeysAreShared();
    const owners = [...(ownerId ? [{ userId: ownerId }] : []), ...(shared ? [{ userId: null }] : [])];
    if (owners.length === 0) return [];
    let providers: string[];
    if (accountId) {
        const current = await prisma.userModelKey.findFirst({
            where: { id: accountId, OR: owners },
            select: { provider: true }
        });
        if (!current) return [];
        providers = [current.provider];
    } else {
        const signins = new Set(agentSignins().map((entry) => entry.slug));
        providers = (core.agentCliById(cli)?.credentials ?? [])
            .map((entry) => signinSlug(entry.env))
            .filter((slug) => signins.has(slug));
    }
    if (providers.length === 0) return [];
    const now = new Date();
    const rows = await prisma.userModelKey.findMany({
        where: {
            OR: owners,
            provider: { in: providers },
            enabled: true,
            AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }]
        },
        select: { id: true, userId: true, name: true, config: true, coolingUntil: true, coolingReason: true },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
        take: 50
    });
    const own = rows.filter((row) => row.userId !== null);
    const instance = rows.filter((row) => row.userId === null);
    return [...own, ...instance].map((row) => ({
        id: row.id,
        name: accountLabel(row),
        coolingUntil: row.coolingUntil ? row.coolingUntil.getTime() : null,
        coolingReason: row.coolingReason
    }));
}

/** The prompt of the turn that failed: the newest thing the person said. */
async function interruptedPrompt(sessionId: string): Promise<string | null> {
    const row = await prisma.agentSessionMessage.findFirst({
        where: { sessionId, role: "user", kind: "text" },
        orderBy: { createdAt: "desc" },
        select: { body: true }
    });
    return row?.body.trim() ? row.body : null;
}

/** Send the failed turn again, once. Never throws: a resend that did not land
 *  leaves the turn where the person can send it themselves. */
async function resend(sessionId: string): Promise<boolean> {
    try {
        const prompt = await interruptedPrompt(sessionId);
        if (!prompt) return false;
        return await queueTurnAgain(sessionId, prompt);
    } catch (error) {
        console.error(
            `[agent-session] ${sessionId}: could not send the turn again:`,
            error instanceof Error ? error.message : "unknown"
        );
        return false;
    }
}

/** Ports the handler reaches out through, so a test can watch them. */
export interface RotationPorts {
    readonly resend: (sessionId: string) => Promise<boolean>;
    readonly notice: (sessionId: string, body: string) => Promise<void>;
    readonly sleep: (ms: number) => Promise<void>;
}

const PORTS: RotationPorts = {
    resend,
    notice: (sessionId, body) => addSessionMessage(sessionId, "system", body),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

/** The failed turn again, once, or a line asking the person for it. */
async function sendAgain(ports: RotationPorts, sessionId: string): Promise<void> {
    if (!(await ports.resend(sessionId))) await ports.notice(sessionId, RESEND_YOURSELF).catch(() => undefined);
}

export type RotationOutcome = "rotated" | "waiting" | "retried" | "ignored";

/**
 * Act on a failed turn: rotate on a usage limit, send again after a wait on an
 * overloaded provider, nothing on anything else. `seq` is the hook's
 * `x-polaris-seq`; a copy of a failure already acted on is dropped by it, and
 * a concurrent one loses the conditional update. Never throws.
 */
export async function handleTurnFailure(
    sessionId: string,
    payload: unknown,
    seq: bigint | null,
    ports: RotationPorts = PORTS,
    now = Date.now()
): Promise<RotationOutcome> {
    try {
        const reading = limitOf(failureOf(payload), now);
        if (reading.kind === "other") return "ignored";
        const row = await prisma.agentSession.findUnique({
            where: { id: sessionId },
            select: {
                startedById: true,
                cli: true,
                accountId: true,
                useMachineLogin: true,
                state: true,
                limitSeq: true,
                limitWaitUntil: true,
                limitRetries: true
            }
        });
        if (!row || core.isSessionOver(row.state as core.AgentSessionState)) return "ignored";
        if (seq !== null && row.limitSeq !== null && seq <= row.limitSeq) return "ignored";
        // A hook too old to send a sequence cannot be told from a copy of the
        // failure that started the wait, so it does not restart one.
        if (seq === null && row.limitWaitUntil && row.limitWaitUntil.getTime() > now) return "ignored";
        const unchanged = {
            id: sessionId,
            accountId: row.accountId,
            limitSeq: row.limitSeq,
            limitWaitUntil: row.limitWaitUntil,
            limitRetries: row.limitRetries
        };

        if (reading.kind === "overloaded") {
            if (row.limitRetries >= OVERLOAD_RETRIES) return "ignored";
            const claimed = await prisma.agentSession.updateMany({
                where: unchanged,
                data: { limitRetries: row.limitRetries + 1, ...(seq !== null ? { limitSeq: seq } : {}) }
            });
            if (claimed.count === 0) return "ignored";
            const wait = OVERLOAD_WAIT_MS * 2 ** row.limitRetries;
            await ports.notice(sessionId, overloadedNotice(wait / SECOND));
            await ports.sleep(wait);
            await sendAgain(ports, sessionId);
            return "retried";
        }

        // The machine answers for itself: Polaris holds nothing to move to.
        if (row.useMachineLogin) return "ignored";
        const accounts = await rotationAccounts(row.startedById, row.cli, row.accountId);
        const currentId = row.accountId ?? accounts[0]?.id ?? null;
        if (!currentId) return "ignored";
        const current = accounts.find((account) => account.id === currentId);
        const until = coolingUntil(currentId, reading.resetAt, now);
        const after = accounts.map((account) =>
            account.id === currentId && (account.coolingUntil ?? 0) < until
                ? { ...account, coolingUntil: until, coolingReason: account.coolingReason && STAYS_OUT.has(account.coolingReason) ? account.coolingReason : "rate" }
                : account
        );
        const next = nextAccount(after, currentId, now);
        const free = next ? null : firstFree(after, now);
        const claimed = await prisma.agentSession.updateMany({
            where: unchanged,
            data: {
                accountId: next ? next.id : row.accountId,
                limitWaitUntil: next ? null : free ? new Date(free.at) : null,
                limitRetries: 0,
                ...(seq !== null ? { limitSeq: seq } : {})
            }
        });
        if (claimed.count === 0) return "ignored";
        // Never over a refusal that outlasts it, and never shorter than one
        // already running.
        await prisma.userModelKey.updateMany({
            where: {
                id: currentId,
                OR: [{ coolingUntil: null }, { coolingUntil: { lt: new Date(until) } }],
                NOT: { coolingReason: { in: [...STAYS_OUT] } }
            },
            data: { coolingUntil: new Date(until), coolingReason: "rate" }
        });
        const from = current?.name ?? (await refusedAccountName(currentId)) ?? "an account";
        if (next) {
            await ports.notice(sessionId, switchedNotice(next.name, from, until, reading.resetAt !== null));
            await sendAgain(ports, sessionId);
            return "rotated";
        }
        await ports.notice(
            sessionId,
            allCoolingNotice(
                after.map((account) => account.name),
                free ? { name: free.account.name, at: free.at } : null
            )
        );
        return "waiting";
    } catch (error) {
        console.error(
            `[agent-session] ${sessionId}: could not act on a usage limit:`,
            error instanceof Error ? error.message : "unknown"
        );
        return "ignored";
    }
}

/** A turn that finished: the overload count and any wait start over. */
export async function noteTurnFinished(sessionId: string): Promise<void> {
    await prisma.agentSession
        .updateMany({
            where: { id: sessionId, OR: [{ limitRetries: { gt: 0 } }, { limitWaitUntil: { not: null } }] },
            data: { limitRetries: 0, limitWaitUntil: null }
        })
        .catch(() => undefined);
}

/** As many waiting sessions as one sweep carries on. */
const SWEEP_BATCH = 20;

/**
 * Carry on the sessions that waited for an account to free up: each moves to
 * the first account of its order that is ready again and its failed turn is
 * sent once more. Claimed by a conditional update on the wait, so two sweeps
 * never send one turn twice. Returns how many carried on.
 */
export async function resumeLimitedSessions(
    ports: RotationPorts = PORTS,
    now = Date.now()
): Promise<number> {
    const due = await prisma.agentSession.findMany({
        where: { limitWaitUntil: { lte: new Date(now) } },
        select: { id: true, startedById: true, cli: true, accountId: true, state: true, limitWaitUntil: true },
        orderBy: { limitWaitUntil: "asc" },
        take: SWEEP_BATCH
    });
    let resumed = 0;
    for (const row of due) {
        const claim = { id: row.id, limitWaitUntil: row.limitWaitUntil };
        if (core.isSessionOver(row.state as core.AgentSessionState)) {
            await prisma.agentSession.updateMany({ where: claim, data: { limitWaitUntil: null } });
            continue;
        }
        const accounts = await rotationAccounts(row.startedById, row.cli, row.accountId).catch(() => []);
        const next = nextAccount(accounts, null, now);
        if (!next) {
            const free = firstFree(accounts, now);
            await prisma.agentSession.updateMany({
                where: claim,
                data: { limitWaitUntil: free ? new Date(free.at) : null }
            });
            continue;
        }
        const claimed = await prisma.agentSession.updateMany({
            where: claim,
            data: { accountId: next.id, limitWaitUntil: null }
        });
        if (claimed.count === 0) continue;
        await ports.notice(row.id, resumedNotice(next.name)).catch(() => undefined);
        await sendAgain(ports, row.id);
        resumed += 1;
    }
    return resumed;
}

/** What to call the account a session's turn runs on, for the event log. Null
 *  when it picked none. */
export async function turnAccountName(sessionId: string): Promise<string | null> {
    const row = await prisma.agentSession
        .findUnique({ where: { id: sessionId }, select: { accountId: true } })
        .catch(() => null);
    return refusedAccountName(row?.accountId ?? null);
}

export type SwitchOutcome = "moved" | "same" | "unknown" | "machine" | "over" | "raced";

/** Ports a switch reaches out through, so a test can watch them. */
export interface SwitchPorts {
    readonly notice: (sessionId: string, body: string) => Promise<void>;
    /** Puts the new account where the next launch reads it, and brings back an
     *  agent that left its terminal on its conversation. */
    readonly restart: (sessionId: string) => Promise<void>;
    /** Sends the turn a limit left waiting. */
    readonly resend: (sessionId: string) => Promise<boolean>;
}

/**
 * Move a session to another of its owner's accounts for its tool, by hand.
 * Only accounts the rotation could pick are taken, so a switch can never land
 * on somebody else's sign-in or another tool's. A wait on a usage limit ends,
 * and the turn it held is sent again on the new account. Never throws on a
 * lost race: two switches at once move the session once.
 */
export async function switchSessionAccount(
    sessionId: string,
    targetId: string,
    ports: SwitchPorts
): Promise<SwitchOutcome> {
    const row = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { startedById: true, cli: true, accountId: true, useMachineLogin: true, state: true, limitWaitUntil: true }
    });
    if (!row || core.isSessionOver(row.state as core.AgentSessionState)) return "over";
    if (row.useMachineLogin) return "machine";
    if (row.accountId === targetId) return "same";
    const accounts = await rotationAccounts(row.startedById, row.cli, row.accountId);
    const target = accounts.find((account) => account.id === targetId);
    if (!target) return "unknown";
    const claimed = await prisma.agentSession.updateMany({
        where: { id: sessionId, accountId: row.accountId, useMachineLogin: false },
        data: { accountId: target.id, limitWaitUntil: null, limitRetries: 0 }
    });
    if (claimed.count === 0) return "raced";
    const from = row.accountId
        ? (accounts.find((account) => account.id === row.accountId)?.name ?? (await refusedAccountName(row.accountId)))
        : null;
    await ports.notice(sessionId, movedNotice(target.name, from)).catch(() => undefined);
    await ports.restart(sessionId);
    if (row.limitWaitUntil) await ports.resend(sessionId).catch(() => false);
    return "moved";
}

/** The accounts a running session could be moved to, for its picker. */
export async function sessionAccountChoices(
    sessionId: string
): Promise<{ current: string | null; accounts: RotationAccount[] } | null> {
    const row = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { startedById: true, cli: true, accountId: true, useMachineLogin: true, state: true }
    });
    if (!row || row.useMachineLogin || core.isSessionOver(row.state as core.AgentSessionState)) return null;
    const accounts = await rotationAccounts(row.startedById, row.cli, row.accountId);
    return { current: row.accountId, accounts };
}

/** The real ports: the turn's resend as rotation does it. */
export function switchPorts(restart: (sessionId: string) => Promise<void>): SwitchPorts {
    return { notice: PORTS.notice, restart, resend };
}
