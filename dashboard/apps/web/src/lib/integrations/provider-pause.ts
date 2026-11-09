/**
 * Stop asking a paid provider that has stopped answering.
 *
 * Every caller of a reputation provider treats a failure the same way, and
 * rightly: not knowing is not blocking, and an outage is not a verdict, so nothing
 * is remembered. What that left out is that the next pass asks again. With the
 * account out of credits every address in the log was asked about on every pass,
 * every thirty seconds, for days, none of which could ever have been answered,
 * while the firewall quietly did nothing.
 *
 * So the provider is paused rather than the address forgotten. One failed request
 * stops all of them, across the firewall, share links and the mail filter, and
 * after the pause a single request finds out whether it is back. Kept in the
 * database, because an update restarts the process and must not restart the loop.
 *
 * This is the one way out to a service billed per request, and `whileServing` is
 * also the last ceiling: requests sent are counted here per day, in the database,
 * so no caller, loop or crashing process can send more than the budget allows.
 * `test/access/metered-gate.test.ts` fails on a call that goes around it.
 */

import { getSetting, setSetting, swapSetting } from "@/lib/setting-store";
import { LOOKUP_BUDGET, takeLookup, type BudgetedProvider } from "@/lib/reputation-budget";

/** Why a provider stopped. The first two need the operator, `budget` lasts until
 *  the day ends, the others pass. */
export type PauseReason = "credits" | "key" | "budget" | "busy" | "unavailable";

/** A refusal of the one value asked about, not of the account or the service. Mail
 *  senders are chosen by strangers, so pausing on these would let one crafted value
 *  switch every check off. The lookup budget is what bounds them. */
const REFUSED_SUBJECT = new Set([400, 404, 422]);

/** Long enough to cost nothing, short enough that topping up works on its own. */
const NEEDS_OPERATOR_MS = 60 * 60 * 1000;
const PASSES_ON_ITS_OWN_MS = 5 * 60 * 1000;

interface StoredPause {
    readonly until: number;
    readonly reason: PauseReason;
}

/** Thrown instead of making a request. Every caller already handles a failure. */
export class ProviderPaused extends Error {
    public readonly reason: PauseReason;

    public constructor(provider: string, reason: PauseReason) {
        super(`${provider} is paused`);
        this.name = "ProviderPaused";
        this.reason = reason;
    }
}

function settingKey(provider: string): string {
    return `integration.pause.${provider}`;
}

/**
 * Count one request against today, or answer false when the day's are gone.
 * A provider billed per character also counts the `chars` sent, and stops once
 * the day's characters are spent.
 *
 * Separate from `takeLookup`, which shares the budget out between callers in
 * memory and starts again with the process. This one survives that, so a dashboard
 * restarting in a loop cannot spend a fresh budget on every start. Every lost swap
 * means somebody else counted, so this ends by the time the day's are gone.
 */
async function spendToday(provider: BudgetedProvider, chars = 0): Promise<boolean> {
    const key = `integration.spent.${provider}`;
    const day = new Date().toISOString().slice(0, 10);
    const { perDay, charsPerDay } = LOOKUP_BUDGET[provider];
    for (;;) {
        const stored = await getSetting(key);
        let count = 0;
        let sent = 0;
        try {
            const parsed = JSON.parse(stored ?? "{}") as {
                day?: unknown;
                count?: unknown;
                chars?: unknown;
            };
            if (parsed.day === day && typeof parsed.count === "number") count = parsed.count;
            if (parsed.day === day && typeof parsed.chars === "number") sent = parsed.chars;
        } catch {
            // Unreadable counts as a new day: the in-memory budget still stands.
        }
        if (count >= perDay) return false;
        if (charsPerDay !== undefined && sent >= charsPerDay) return false;
        const next = JSON.stringify({ day, count: count + 1, chars: sent + Math.max(0, chars) });
        if (await swapSetting(key, stored, next)) return true;
    }
}

/** The day's requests are gone: stop until it ends, and say so. The first request of
 *  the next day that is answered clears the notice like any other pause. */
async function stopForToday(provider: BudgetedProvider, name: string): Promise<void> {
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    console.error(`polaris: ${provider} spent today's budget`);
    await setSetting(
        settingKey(provider),
        JSON.stringify({ until: midnight.getTime(), reason: "budget" } satisfies StoredPause)
    );
    await tellOperators(provider, name, "budget");
}

async function storedPause(provider: string): Promise<StoredPause | null> {
    const raw = await getSetting(settingKey(provider));
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<StoredPause>;
        return typeof parsed.until === "number" && typeof parsed.reason === "string"
            ? { until: parsed.until, reason: parsed.reason }
            : null;
    } catch {
        return null;
    }
}

/** Whether this provider must not be asked right now. */
export async function providerPaused(provider: string): Promise<boolean> {
    const pause = await storedPause(provider);
    return pause !== null && pause.until > Date.now();
}

/**
 * Take a lookup from the provider's budget, unless it is paused. Nothing is sent
 * during a pause, and budget spent on nothing would outlast it, refusing the checks
 * that should resume once the provider is back.
 */
export async function takeServedLookup(
    provider: BudgetedProvider,
    share?: number
): Promise<boolean> {
    return !(await providerPaused(provider)) && takeLookup(provider, share);
}

/** The HTTP status of a failure, from an axios error or a plain one carrying it. */
function failureStatus(caught: unknown): number | undefined {
    if (!caught || typeof caught !== "object") return undefined;
    const failure = caught as { status?: unknown; response?: { status?: unknown } };
    const status = failure.response?.status ?? failure.status;
    return typeof status === "number" ? status : undefined;
}

/** The status or the error's name, never its text: an axios error carries the
 *  request, and the request carries the key. */
function describe(caught: unknown): string {
    return String(failureStatus(caught) ?? (caught instanceof Error ? caught.name : "unknown"));
}

/** The longest a provider's own "come back at" is taken at its word. */
const LONGEST_SAID_MS = 31 * 24 * 60 * 60 * 1000;

/** A response header off an axios error (a plain object or AxiosHeaders) or a fetch one. */
function failureHeader(caught: unknown, name: string): string | undefined {
    if (!caught || typeof caught !== "object") return undefined;
    const headers = (caught as { response?: { headers?: unknown } }).response?.headers;
    if (!headers || typeof headers !== "object") return undefined;
    const reader = headers as { get?: (key: string) => unknown };
    const value =
        typeof reader.get === "function"
            ? reader.get(name)
            : (headers as Record<string, unknown>)[name];
    if (typeof value === "number") return String(value);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * When a header says to come back, as a time: seconds (`120`), a duration
 * (`1h30m`, `45s`, `200ms`), an epoch in seconds or milliseconds, or a date.
 * Null when it says nothing usable.
 */
export function comeBackAt(value: string, now: number): number | null {
    if (/^\d+(\.\d+)?$/.test(value)) {
        const number = Number(value);
        // An epoch, in milliseconds or in seconds, against a count of seconds.
        if (number > 1e12) return number;
        if (number > 1e9) return number * 1000;
        return now + number * 1000;
    }
    const duration = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(value);
    if (duration && duration.slice(1).some(Boolean)) {
        const [, d, h, m, sec, ms] = duration;
        return (
            now +
            Number(d ?? 0) * 86_400_000 +
            Number(h ?? 0) * 3_600_000 +
            Number(m ?? 0) * 60_000 +
            Number(sec ?? 0) * 1000 +
            Number(ms ?? 0)
        );
    }
    const date = Date.parse(value);
    return Number.isNaN(date) ? null : date;
}

/**
 * When the provider said it can be asked again: out of credits until they
 * renew, busy until the window resets. Read from the refusal itself, so nothing
 * is sent before then just to find out. Null when it did not say, or said
 * something already past or absurdly far off.
 */
export function saidUntil(caught: unknown, now = Date.now()): number | null {
    let latest: number | null = null;
    for (const name of ["retry-after", "x-ratelimit-reset-requests", "x-ratelimit-reset"]) {
        const value = failureHeader(caught, name);
        const at = value ? comeBackAt(value, now) : null;
        if (at !== null && at > now && at - now <= LONGEST_SAID_MS) latest = Math.max(latest ?? 0, at);
    }
    return latest;
}

/** What a failure means for the next request, or null when it says nothing about
 *  any request but this one. */
export function pauseReasonFor(caught: unknown): PauseReason | null {
    const status = failureStatus(caught);
    if (status !== undefined && REFUSED_SUBJECT.has(status)) return null;
    if (status === 402) return "credits";
    if (status === 401 || status === 403) return "key";
    if (status === 429) return "busy";
    return "unavailable";
}

/** The characters a per-character provider bills for `texts`. */
export function billedChars(texts: readonly string[]): number {
    return texts.reduce((sum, text) => sum + text.length, 0);
}

/**
 * Make one request to a paid provider, or none if it is paused. `chars` is what
 * the request is billed for, by a provider that bills per character.
 */
export async function whileServing<T>(
    provider: BudgetedProvider,
    name: string,
    ask: () => Promise<T>,
    chars = 0
): Promise<T> {
    const pause = await storedPause(provider);
    if (pause && pause.until > Date.now()) throw new ProviderPaused(provider, pause.reason);
    if (!(await spendToday(provider, chars))) {
        await stopForToday(provider, name);
        throw new ProviderPaused(provider, "budget");
    }
    try {
        const answer = await ask();
        // It answered, so whatever stopped it is over, topped up or not by hand.
        if (pause) await clearProviderPause(provider);
        return answer;
    } catch (caught) {
        const reason = pauseReasonFor(caught);
        if (!reason) {
            console.error(`polaris: ${name} refused a request:`, describe(caught));
            throw caught;
        }
        const needsOperator = reason === "credits" || reason === "key";
        const wait = needsOperator ? NEEDS_OPERATOR_MS : PASSES_ON_ITS_OWN_MS;
        // The provider's own word on when it can be asked again - credits renewing,
        // a window resetting - beats a guess, so nothing is sent before then.
        const said = reason === "key" ? null : saidUntil(caught);
        const until = said ?? Date.now() + wait;
        console.error(
            `polaris: ${name} paused (${reason}) until ${new Date(until).toISOString()}${said ? " as it said" : ""}:`,
            describe(caught)
        );
        await setSetting(
            settingKey(provider),
            JSON.stringify({ until, reason } satisfies StoredPause)
        );
        if (needsOperator) await tellOperators(provider, name, reason);
        throw caught;
    }
}

/** The alert and the card's notice. An out-of-service failure is one ongoing
 *  condition, so the hourly retry rewrites its notice instead of raising another. */
async function tellOperators(
    provider: string,
    name: string,
    reason: "credits" | "key" | "budget"
): Promise<void> {
    // Imported when needed: it reaches notifications and storage, which every caller
    // of a provider would otherwise load for a path that almost never runs.
    const { recordConnectionFailure } = await import("@/lib/connections/attention");
    await recordConnectionFailure(provider, reason, "out-of-service", {
        // i18n-ignore the fallback; each operator reads `say` in their language
        title: `${name} has stopped working`,
        // i18n-ignore the fallback; each operator reads `say` in their language
        body:
            reason === "credits"
                ? `${name} is out of credits, so Polaris stopped asking it. Its checks are off until it has credits again.`
                : reason === "key"
                  ? `${name} refused the key, so Polaris stopped asking it. Its checks are off until the key works.`
                  : `${name} used up today's requests, so Polaris stopped asking it. Its checks come back at midnight UTC.`,
        say: (t) => ({
            title: t("connections.stoppedTitle", { name }),
            body:
                reason === "credits"
                    ? t("connections.stoppedCredits", { name })
                    : reason === "key"
                      ? t("connections.stoppedKey", { name })
                      : t("connections.stoppedBudget", { name })
        })
    });
}

/** Ask again now: the operator changed something, or the provider answered. */
export async function clearProviderPause(provider: string): Promise<void> {
    await setSetting(settingKey(provider), null);
    const { clearConnectionFailure } = await import("@/lib/connections/attention");
    await clearConnectionFailure(provider, "out-of-service");
}
