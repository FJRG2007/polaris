/**
 * The guided setup's unfinished answers, kept in the browser so a reload does not
 * throw them away, and the rules for what "unfinished" even means: which answers the
 * setup opens with, and whether what is on screen says anything the server does not
 * already hold.
 *
 * Local storage on purpose: nothing here is a decision yet - it is what the operator
 * has typed so far, and writing half a domain layout to the server would put the box
 * in a state nobody asked for.
 *
 * Everything read back is parsed like any other untrusted input: this is storage the
 * operator's own browser can edit, and a draft that no longer fits (an option renamed
 * since, a hand-edited value) is dropped rather than half-applied.
 *
 * The DuckDNS token is deliberately absent. A secret does not go to local storage, so
 * it is the one answer that has to be typed again.
 */

import { z } from "zod";
import { serverEnvironmentSchema } from "@polaris/core";
import { strategiesFor, EXPOSURE_STRATEGIES, type ExposureStrategy } from "@/lib/domain-strategies";
import type { DomainSetupState } from "./setup-actions";

/** Where the draft lives. Versioned, so a changed shape is ignored, not migrated. */
const DRAFT_KEY = "polaris.domain-setup.v1";

export const setupDraftSchema = z.object({
    /** Capped at the last question: the step after it is only reachable by saving. */
    step: z.number().int().min(0).max(2),
    environment: serverEnvironmentSchema,
    strategy: z.enum(EXPOSURE_STRATEGIES as [ExposureStrategy, ...ExposureStrategy[]]),
    baseDomain: z.string(),
    zones: z.array(z.object({ label: z.string(), scope: z.enum(["polaris", "deploy"]), primary: z.boolean() })),
    duckSub: z.string(),
    useForDashboard: z.boolean()
});

export type SetupDraft = z.infer<typeof setupDraftSchema>;

/** The answers, without the position in the wizard that holds them. */
export type SetupAnswers = Omit<SetupDraft, "step">;

/**
 * The strategy a saved layout is already running. Reopening the setup then shows what
 * the box actually does, instead of the recommendation it would get if nothing were
 * configured: that recommendation can be a strategy with no domain at all, which hides
 * the operator's own domain behind two steps and skips the provider lookup that the
 * Cloudflare shortcut hangs off.
 *
 * The answer the setup saved comes first, because what it leaves behind cannot always
 * be read back: the two tunnels both store the exposure mode "tunnel" with no domain,
 * and a free subdomain stores what an untouched box already holds. Inferring from the
 * layout is the fallback for a setup saved before the answer was recorded.
 */
export function configuredStrategy(state: DomainSetupState): ExposureStrategy | null {
    if (state.strategy) return state.strategy;
    if (state.zones.baseDomain.endsWith(".duckdns.org")) return "duckdns";
    if (state.zones.baseDomain) return "own-domain";
    return state.network.mode === "tunnel" ? "cloudflare-tunnel" : null;
}

/** The answers the setup opens with when there is no draft to resume. */
export function savedAnswers(state: DomainSetupState): SetupAnswers {
    return {
        environment: state.environment.environment,
        strategy: configuredStrategy(state) ?? strategiesFor(state.environment.environment).recommended,
        baseDomain: state.zones.baseDomain,
        zones: state.zones.zones.map((zone) => ({ ...zone })),
        duckSub: state.domains.duckdnsSubdomain,
        // Not stored as such: the setup records it as an intention that the DNS check
        // carries out and clears, so the answer starts from its default every time.
        useForDashboard: true
    };
}

/**
 * Whether the answers on screen say anything the server does not already hold. A draft
 * that merely repeats what is configured is worse than no draft: it resumes the
 * operator into a form they had opened to look at, rather than onto the state of the
 * domain they came to check.
 *
 * `useForDashboard` is left out on purpose: it is an intention the server carries out
 * and clears rather than an answer it keeps, so it reads back as its default however
 * it was saved - and comparing it would call every setup unsaved for good the moment
 * an operator unticked it once.
 */
export function isUntouched(answers: SetupAnswers, state: DomainSetupState): boolean {
    const saved = savedAnswers(state);
    return (
        answers.environment === saved.environment &&
        answers.strategy === saved.strategy &&
        answers.baseDomain === saved.baseDomain &&
        answers.duckSub === saved.duckSub &&
        answers.zones.length === saved.zones.length &&
        answers.zones.every((zone, index) => {
            const other = saved.zones[index];
            return (
                other !== undefined &&
                zone.label === other.label &&
                zone.scope === other.scope &&
                zone.primary === other.primary
            );
        })
    );
}

/** The answers so far, or null when there is nothing usable to resume from. */
export function readSetupDraft(): SetupDraft | null {
    try {
        const raw = window.localStorage.getItem(DRAFT_KEY);
        if (!raw) return null;
        const parsed = setupDraftSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        // Storage can be unavailable (private mode, blocked cookies) and the stored
        // text can be anything: a setup that cannot be resumed is fine, one that
        // cannot render is not.
        return null;
    }
}

export function writeSetupDraft(draft: SetupDraft): void {
    try {
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
        // As above - losing the ability to resume must not break the setup.
    }
}

export function clearSetupDraft(): void {
    try {
        window.localStorage.removeItem(DRAFT_KEY);
    } catch {
        // As above.
    }
}
