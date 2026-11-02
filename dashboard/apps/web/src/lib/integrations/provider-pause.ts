/**
 * Stop asking a paid provider that has stopped answering.
 *
 * Every caller of a reputation provider treats a failure the same way, and
 * rightly: not knowing is not blocking, and an outage is not a verdict, so nothing
 * is remembered. What that left out is that the next pass asks again. With the
 * account out of credits every address in the log was asked about on every pass,
 * every thirty seconds, for a week: over two hundred thousand requests, none of
 * which could ever have been answered, while the firewall quietly did nothing.
 *
 * So the provider is paused rather than the address forgotten. One failed request
 * stops all of them, across the firewall, share links and the mail filter, and
 * after the pause a single request finds out whether it is back. Kept in the
 * database, because an update restarts the process and must not restart the loop.
 */

import { getSetting, setSetting } from "@/lib/setting-store";
import { takeLookup, type BudgetedProvider } from "@/lib/reputation-budget";

/** Why a provider stopped. The first two need the operator, the others pass. */
export type PauseReason = "credits" | "key" | "busy" | "unavailable";

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
    public constructor(provider: string) {
        super(`${provider} is paused`);
        this.name = "ProviderPaused";
    }
}

function settingKey(provider: string): string {
    return `integration.pause.${provider}`;
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

/** Make one request to a paid provider, or none if it is paused. */
export async function whileServing<T>(
    provider: string,
    name: string,
    ask: () => Promise<T>
): Promise<T> {
    const pause = await storedPause(provider);
    if (pause && pause.until > Date.now()) throw new ProviderPaused(provider);
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
        console.error(`polaris: ${name} paused (${reason}):`, describe(caught));
        await setSetting(
            settingKey(provider),
            JSON.stringify({ until: Date.now() + wait, reason } satisfies StoredPause)
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
    reason: "credits" | "key"
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
                : `${name} refused the key, so Polaris stopped asking it. Its checks are off until the key works.`,
        say: (t) => ({
            title: t("connections.stoppedTitle", { name }),
            body:
                reason === "credits"
                    ? t("connections.stoppedCredits", { name })
                    : t("connections.stoppedKey", { name })
        })
    });
}

/** Ask again now: the operator changed something, or the provider answered. */
export async function clearProviderPause(provider: string): Promise<void> {
    await setSetting(settingKey(provider), null);
    const { clearConnectionFailure } = await import("@/lib/connections/attention");
    await clearConnectionFailure(provider, "out-of-service");
}
