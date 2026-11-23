/**
 * Which second factors an account accepts, and how many of them a sign-in owes.
 *
 * Modelled on how the large providers structure it: Google's 2-Step Verification
 * lets an account hold several methods and asks for more ("Verify it's you") when
 * a sign-in looks unusual; Binance's security verification can require every
 * bound method at once; Keycloak's conditional step-up flows express the same
 * thing as "required factors per risk level". Here that is three choices an
 * account makes for itself, and one risk signal: a country it does not usually
 * sign in from.
 *
 * Everything in this file is pure so the decision can be stated and checked on
 * its own - the server work around it lives in two-factor-policy-service.ts.
 *
 * Two rules hold whatever the account chose, because the alternative is an owner
 * locked out of their own account:
 * - a policy can only ask for methods that are set up and able to deliver right
 *   now, so a method removed or a channel gone shrinks what is asked for;
 * - a backup code always gets a sign-in through on its own.
 */

import { z } from "zod";
import { TWO_FACTOR_METHODS, type SecondFactor, type TwoFactorMethod } from "@polaris/core";

/** How strict a sign-in is, from the least to the most. */
export const TWO_FACTOR_STRICTNESS = ["standard", "unusual", "all"] as const;

export type TwoFactorStrictness = (typeof TWO_FACTOR_STRICTNESS)[number];

/** Asking for more from an unusual country is on unless the account turns it off. */
export const DEFAULT_STRICTNESS: TwoFactorStrictness = "unusual";

export interface TwoFactorPolicy {
    /** Methods set up but not taken as a second factor. */
    refused: TwoFactorMethod[];
    strictness: TwoFactorStrictness;
}

export const DEFAULT_POLICY: TwoFactorPolicy = { refused: [], strictness: DEFAULT_STRICTNESS };

/** How many countries an account remembers as its usual ones. */
export const USUAL_COUNTRY_LIMIT = 5;

const methodField = z.enum(TWO_FACTOR_METHODS);
const strictnessField = z.enum(TWO_FACTOR_STRICTNESS);

/** What the settings page sends. */
export const twoFactorPolicySchema = z.object({
    refused: z
        .array(methodField)
        .max(TWO_FACTOR_METHODS.length)
        .transform((values) => Array.from(new Set(values))),
    strictness: strictnessField
});

export type TwoFactorPolicyInput = z.infer<typeof twoFactorPolicySchema>;

/** The stored row, read total: anything unreadable falls back to the default. */
export function parsePolicy(
    row: { twoFactorRefused?: string | null; twoFactorStrictness?: string | null } | null | undefined
): TwoFactorPolicy {
    if (!row) return DEFAULT_POLICY;
    let refused: TwoFactorMethod[] = [];
    try {
        const parsed = z.array(methodField).safeParse(JSON.parse(row.twoFactorRefused ?? "[]"));
        refused = parsed.success ? Array.from(new Set(parsed.data)) : [];
    } catch {
        refused = [];
    }
    const strictness = strictnessField.safeParse(row.twoFactorStrictness);
    return { refused, strictness: strictness.success ? strictness.data : DEFAULT_STRICTNESS };
}

/**
 * The methods a sign-in may use: what is set up, minus what the account refused.
 * Never empty while anything is set up - if the refusals would leave nothing
 * (the last accepted channel went down), every set-up method is accepted again,
 * because a policy nobody can satisfy is a locked account.
 */
export function acceptedMethods(
    setUp: readonly TwoFactorMethod[],
    refused: readonly TwoFactorMethod[]
): TwoFactorMethod[] {
    const accepted = setUp.filter((method) => !refused.includes(method));
    return accepted.length > 0 ? accepted : [...setUp];
}

/** What a sign-in owes in total, before anything has been answered. */
export interface Requirement {
    /** Distinct second factors. */
    factors: number;
    /** Whether the security questions are asked as well. */
    question: boolean;
}

export function requiredFactors(input: {
    strictness: TwoFactorStrictness;
    unusual: boolean;
    /** How many methods are accepted. */
    accepted: number;
    hasQuestions: boolean;
}): Requirement {
    const { strictness, unusual, accepted, hasQuestions } = input;
    if (strictness === "all") return { factors: Math.max(1, accepted), question: unusual && hasQuestions };
    if (strictness === "unusual" && unusual) return { factors: 2, question: hasQuestions };
    return { factors: 1, question: false };
}

/**
 * Whether a sign-in's country is one the account does not usually use.
 *
 * An unknown country - a private address, a lookup that failed, a deployment
 * with no geolocation - is never unusual: treating it as unusual would ask every
 * sign-in on a home network for more, and an outage of the lookup would become an
 * outage of everybody's sign-in. Nor is anything unusual for an account with no
 * history yet: its first sign-in is what starts the history.
 */
export function isUnusualCountry(country: string | null | undefined, usual: readonly string[]): boolean {
    if (!country) return false;
    if (usual.length === 0) return false;
    return !usual.includes(country.toUpperCase());
}

/** The usual countries after a finished sign-in: most recent first, bounded. */
export function rememberCountry(usual: readonly string[], country: string | null | undefined): string[] {
    if (!country) return [...usual];
    const code = country.toUpperCase();
    return [code, ...usual.filter((entry) => entry !== code)].slice(0, USUAL_COUNTRY_LIMIT);
}

/** The second factor a sign-in answered, as the method it counts for. */
const FACTOR_METHOD: Partial<Record<SecondFactor, TwoFactorMethod>> = {
    totp: "totp",
    "email-code": "email",
    "whatsapp-code": "whatsapp",
    "telegram-code": "telegram"
};

/** Why a sign-in was asked for more, for the screen that asks. */
export type StepUpReason = "unusual-country" | "all-methods" | "not-accepted" | "new-device" | "impossible-travel" | "datacenter";

/** What a sign-in still owes, as stored against its session. */
export interface StepUpState {
    /** Distinct factors owed in total, the one already answered included. */
    need: number;
    /** Methods the remaining factors may come from. */
    accepted: TwoFactorMethod[];
    /** Factors answered so far: methods, or the first factor's own name when it
     *  was not one of the methods (a remembered browser, the phone app). */
    done: string[];
    question: boolean;
    questionDone: boolean;
    /** Whether the phone number was confirmed before a WhatsApp code. */
    phoneConfirmed: boolean;
    /** Whether the whole address was typed back before an email code. */
    emailConfirmed: boolean;
    reason: StepUpReason;
}

const stepUpStateSchema = z.object({
    need: z.number().int().min(0).max(TWO_FACTOR_METHODS.length + 1),
    accepted: z.array(methodField),
    done: z.array(z.string().max(32)).max(TWO_FACTOR_METHODS.length + 1),
    question: z.boolean(),
    questionDone: z.boolean(),
    phoneConfirmed: z.boolean(),
    // Rows written before the address was asked for read as not confirmed yet.
    emailConfirmed: z.boolean().default(false),
    reason: z.enum(["unusual-country", "all-methods", "not-accepted", "new-device", "impossible-travel", "datacenter"])
});

/**
 * Read a stored state. Anything unreadable is treated as owing the full extra
 * step again rather than nothing: a corrupted row must never open a session.
 */
export function parseStepUp(value: string | null | undefined): StepUpState | null {
    if (!value) return null;
    try {
        const parsed = stepUpStateSchema.safeParse(JSON.parse(value));
        if (parsed.success) return parsed.data;
    } catch {
        // Falls through to the conservative reading below.
    }
    return {
        need: 1,
        accepted: [...TWO_FACTOR_METHODS],
        done: [],
        question: false,
        questionDone: false,
        phoneConfirmed: false,
        emailConfirmed: false,
        reason: "not-accepted"
    };
}

export function serializeStepUp(state: StepUpState): string {
    return JSON.stringify(state);
}

/**
 * What a sign-in still owes after its first factor, or null when it owes nothing.
 *
 * Null too when no challenge was answered at all (the account has no second
 * factor, or signed in with a passkey) and when a backup code was used - so an
 * account that never touches these settings signs in exactly as it always did.
 */
export function planStepUp(input: {
    factor: SecondFactor | null;
    accepted: readonly TwoFactorMethod[];
    requirement: Requirement;
    reasonHint: "unusual-country" | null;
}): StepUpState | null {
    const { factor, accepted, requirement } = input;
    if (!factor || factor === "backup-code") return null;

    const method = FACTOR_METHOD[factor];
    // A method the account refused proves nothing here; anything else that
    // answered the challenge counts once.
    const done: string[] = method ? (accepted.includes(method) ? [method] : []) : [factor];
    const left = accepted.filter((entry) => !done.includes(entry));
    // Never more than can actually be answered.
    const need = Math.min(requirement.factors, done.length + left.length);
    const owesFactors = need > done.length;
    if (!owesFactors && !requirement.question) return null;

    const reason: StepUpReason =
        method && !accepted.includes(method) && done.length === 0
            ? "not-accepted"
            : input.reasonHint === "unusual-country"
              ? "unusual-country"
              : "all-methods";
    return {
        need: Math.max(need, done.length),
        accepted: [...accepted],
        done,
        question: requirement.question,
        questionDone: false,
        phoneConfirmed: false,
        emailConfirmed: false,
        reason
    };
}

/**
 * The extra check a risky sign-in owes when nothing else was asked of it: an
 * account with no second factor, signing in with its password. One code from
 * any way the account can receive one right now; null when there is none, so a
 * risky sign-in is never left at a step nobody can answer.
 */
export function planRiskCheck(input: {
    available: readonly TwoFactorMethod[];
    reason: "unusual-country" | "new-device" | "impossible-travel" | "datacenter";
}): StepUpState | null {
    if (input.available.length === 0) return null;
    return {
        need: 1,
        accepted: [...input.available],
        done: [],
        question: false,
        questionDone: false,
        phoneConfirmed: false,
        emailConfirmed: false,
        reason: input.reason
    };
}

/** What is still to answer. */
export function stepUpRemaining(state: StepUpState): {
    factorsLeft: number;
    methods: TwoFactorMethod[];
    questionLeft: boolean;
} {
    const factorsLeft = Math.max(0, state.need - state.done.length);
    return {
        factorsLeft,
        methods: factorsLeft > 0 ? state.accepted.filter((method) => !state.done.includes(method)) : [],
        questionLeft: state.question && !state.questionDone
    };
}

export function stepUpComplete(state: StepUpState): boolean {
    const left = stepUpRemaining(state);
    return left.factorsLeft === 0 && !left.questionLeft;
}

/** Count one more method answered. A method that is not owed changes nothing. */
export function recordFactor(state: StepUpState, method: TwoFactorMethod): StepUpState {
    if (!stepUpRemaining(state).methods.includes(method)) return state;
    return { ...state, done: [...state.done, method] };
}

/** Steps done and in total, for "Step 2 of 3". */
export function stepUpProgress(state: StepUpState): { done: number; total: number } {
    const total = state.need + (state.question ? 1 : 0);
    const done = Math.min(state.need, state.done.length) + (state.question && state.questionDone ? 1 : 0);
    return { done, total };
}

/**
 * Whether what somebody typed is the number a code would go to - the whole
 * number, with or without its country prefix. Compared over a fixed width so
 * the time taken does not depend on where the first wrong digit is.
 */
export function phoneMatches(typed: string, phone: string): boolean {
    const given = typed.replace(/\D/g, "");
    const expected = phone.replace(/\D/g, "");
    // Shorter than a national number is a guess at the tail, not a confirmation.
    if (given.length < 6 || expected.length === 0 || given.length > expected.length) return false;
    const tail = expected.slice(expected.length - given.length);
    // A typed number without its prefix still has to cover the national part.
    const coversNational = expected.length - given.length <= 3;
    const width = 20;
    let diff = coversNational ? 0 : 1;
    for (let index = 0; index < width; index += 1) {
        diff |= (given.charCodeAt(index) || 0) ^ (tail.charCodeAt(index) || 0);
    }
    return diff === 0;
}

/** Whether a change asks more of the next sign-in than the current policy does. */
export function isStricter(previous: TwoFactorPolicy, next: TwoFactorPolicy): boolean {
    const rank = (value: TwoFactorStrictness) => TWO_FACTOR_STRICTNESS.indexOf(value);
    return (
        rank(next.strictness) > rank(previous.strictness) ||
        next.refused.some((method) => !previous.refused.includes(method))
    );
}

/**
 * The address an email code would go to, shown the way Google does before it
 * sends one: "f***@g***.com". Enough for the owner to know which inbox, not
 * enough for somebody holding only the password to learn it.
 */
export function emailHint(email: string): string {
    const at = email.lastIndexOf("@");
    if (at <= 0 || at === email.length - 1) return "***";
    const domain = email.slice(at + 1);
    const dot = domain.lastIndexOf(".");
    const suffix = dot > 0 ? domain.slice(dot) : "";
    return `${email[0]}***@${domain[0]}***${suffix}`;
}

/**
 * Whether what somebody typed is the whole address a code would go to, in any
 * casing. Compared over a fixed width so the time taken does not depend on
 * where the first wrong character is.
 */
export function emailMatches(typed: string, email: string): boolean {
    const given = typed.trim().toLowerCase();
    const expected = email.trim().toLowerCase();
    if (given.length === 0 || expected.length === 0) return false;
    const width = 320;
    let diff = given.length === expected.length ? 0 : 1;
    for (let index = 0; index < width; index += 1) {
        diff |= (given.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
    }
    return diff === 0;
}
