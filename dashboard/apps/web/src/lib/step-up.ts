/**
 * Asking an open session to prove itself again, right before something that
 * cannot be undone.
 *
 * A session is a claim that somebody signed in once, on some device, at some
 * point. It is a fine basis for reading a page and a poor one for destroying an
 * organization: the whole value of a stolen laptop is the sessions already on
 * it. So the acts that end things ask for the second factor again, at the moment
 * of the act, rather than trusting what the sign-in concluded hours ago.
 *
 * Which proof is asked for is the account's, not the caller's: whatever it armed
 * is what it is asked for, in the order it would be trusted. An account that
 * armed nothing is asked for its password - which proves less than a factor, and
 * still turns a stolen open session into one that also needs the password.
 */

import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { deliverCode, describeTwoFactorMethods } from "@/lib/two-factor-delivery";
import { z } from "zod";
import { issueStepUpCode, verifyAccountPassword, verifyStepUpCode, verifyTotpForSession } from "@polaris/auth";
import {
    STEP_UP_PROOF_LABELS,
    stepUpProofSchema,
    type StepUpProof,
    type StepUpProofInput,
    type TwoFactorDeliveryMethod
} from "@polaris/core";
import { codeMessageFor } from "@/lib/code-message";
import { TWO_FACTOR_RESEND_SECONDS } from "@/lib/two-factor-resend";
import { readerWords } from "@/lib/i18n/reader-words";
import { opaqueFinish } from "@/lib/chat/e2ee/schemas";
import { provesPassword } from "@/lib/chat/e2ee/opaque-password";

/**
 * The password proof made over OPAQUE (docs/chat-e2ee-phase1.md, "Password flows
 * over OPAQUE"): the finish of a `proof-start` login instead of the password. It
 * is the account's "password" choice, offered and refused exactly like it.
 */
export const opaquePasswordProofSchema = opaqueFinish.extend({ proof: z.literal("opaque-password") });
export type AnyStepUpProof = StepUpProofInput | z.infer<typeof opaquePasswordProofSchema>;

/** The proof a form sent, either shape. */
export const anyStepUpProofSchema = z.union([stepUpProofSchema, opaquePasswordProofSchema]);

/** Wrong proofs one account may offer, and over what span. Tighter than a
 *  sign-in: nobody reaches this screen by accident, and the person holding the
 *  session is already past every other gate. */
const PROOF_LIMIT = 5;
const PROOF_WINDOW_MS = 15 * 60 * 1000;

/** One way this account could prove itself, as the confirmation draws it. */
export interface StepUpChoice {
    proof: StepUpProof;
    label: string;
    /** Masked address or number for the methods that send a code, so the reader
     *  knows which inbox to open. Null for the authenticator and the password. */
    target: string | null;
    /** Whether the reader has to ask for a code before they can type one. */
    sends: boolean;
}

/** What the confirmation offers, and which entry it opens on. */
export interface StepUpOptions {
    choices: StepUpChoice[];
    /** The strongest proof available, which is where the dialog starts. */
    preferred: StepUpProof;
}

/**
 * The ways this account can confirm right now.
 *
 * Ordered by what each one proves rather than by preference. The authenticator
 * is first because it is the only factor that needs nothing from the deployment;
 * the delivered codes follow; the password is last and is only offered when
 * there is no factor at all, because offering it alongside one would let anybody
 * holding the session pick the weakest door.
 */
export async function stepUpOptions(userId: string): Promise<StepUpOptions> {
    const statuses = await describeTwoFactorMethods(userId);
    const usable = statuses.filter((status) => status.enabled && status.available);

    const choices: StepUpChoice[] = usable.map((status) => ({
        proof: status.method,
        label: STEP_UP_PROOF_LABELS[status.method],
        target: status.target,
        sends: status.method !== "totp"
    }));
    if (choices.length === 0) {
        choices.push({ proof: "password", label: STEP_UP_PROOF_LABELS.password, target: null, sends: false });
    }
    return { choices, preferred: choices[0]!.proof };
}

/**
 * Send the code for one delivery method.
 *
 * The method is checked against what the account actually has open rather than
 * taken at its word, so a hand-made request can at most pick between the inboxes
 * its owner already confirmed.
 */
export async function sendStepUpCode(
    userId: string,
    purpose: string,
    method: TwoFactorDeliveryMethod,
    /**
     * The sign-in risk check: any way the account can receive a code right now
     * counts, set up as a second factor or not - an account with none is
     * exactly the one being asked. The caller has already checked the method
     * is one the session's own step-up state offered.
     */
    options: { anyReachable?: boolean } = {}
): Promise<{ error?: string }> {
    const reachable = options.anyReachable
        ? (await describeTwoFactorMethods(userId)).some((status) => status.method === method && status.available)
        : (await stepUpOptions(userId)).choices.some((choice) => choice.proof === method);
    if (!reachable) {
        return { error: (await readerWords("accountSecurity"))("known.notAWayToConfirm") };
    }

    // One code per method per resend wait, checked before a code is issued so a
    // refused press leaves the one already sent working.
    const wait = await rateLimit(`step-up-wait:${userId}:${method}`, 1, TWO_FACTOR_RESEND_SECONDS * 1000);
    if (!wait.ok) {
        return { error: (await readerWords("auth"))("twoFactor.waitBeforeAnother", { seconds: Math.ceil(wait.retryAfterMs / 1000) }) };
    }
    const throttle = await rateLimit(`step-up-send:${userId}`, PROOF_LIMIT, PROOF_WINDOW_MS);
    if (!throttle.ok) {
        return { error: (await readerWords("accountSecurity"))("errors.tooManyCodes", { minutes: minutes(throttle.retryAfterMs) }) };
    }

    const code = await issueStepUpCode(auth, userId, purpose);
    const message = await codeMessageFor(userId, "stepUp", code);
    const result = await deliverCode(userId, method, { ...message, code });
    await recordAudit({
        actorId: userId,
        action: result.error ? "account.step-up.code-failed" : "account.step-up.code-sent",
        metadata: { purpose, method }
    });
    return result;
}

/**
 * Check what the person typed.
 *
 * Returns the sentence to show rather than a boolean, because every refusal here
 * means something different to the person reading it - a wrong code, a spent
 * one, a proof this account never armed - and "we could not verify that" sends
 * somebody to look for a problem that is not there.
 *
 * A proof the account cannot use is refused before it is checked. Without that,
 * an account with a second factor could offer its password instead and the gate
 * would quietly become the thing it was put there to strengthen.
 */
export async function proveStepUp(
    userId: string,
    purpose: string,
    proof: AnyStepUpProof,
    /** As for `sendStepUpCode`: the sign-in risk check accepts any reachable method. */
    options: { anyReachable?: boolean } = {}
): Promise<{ error?: string }> {
    const throttle = await rateLimit(`step-up:${userId}`, PROOF_LIMIT, PROOF_WINDOW_MS);
    if (!throttle.ok) {
        return { error: (await readerWords("accountSecurity"))("errors.tooManyAttempts", { minutes: minutes(throttle.retryAfterMs) }) };
    }

    // A password proven over OPAQUE is the same "password" choice.
    const asked = proof.proof === "opaque-password" ? "password" : proof.proof;
    const offered = options.anyReachable
        ? (await describeTwoFactorMethods(userId)).some((status) => status.method === asked && status.available)
        : (await stepUpOptions(userId)).choices.some((choice) => choice.proof === asked);
    if (!offered) {
        return { error: (await readerWords("accountSecurity"))("known.notAWayToConfirm") };
    }

    const result = await check(userId, purpose, proof);
    await recordAudit({
        actorId: userId,
        action: result.error ? "account.step-up.failed" : "account.step-up.passed",
        metadata: { purpose, proof: proof.proof }
    });
    return result;
}

async function check(userId: string, purpose: string, proof: AnyStepUpProof): Promise<{ error?: string }> {
    if (proof.proof === "opaque-password") {
        return (await provesPassword(userId, proof))
            ? {}
            : { error: (await readerWords("accountSecurity"))("known.wrongStepUpPassword") };
    }
    if (proof.proof === "password") {
        return (await verifyAccountPassword(auth, userId, proof.password))
            ? {}
            : { error: (await readerWords("accountSecurity"))("known.wrongStepUpPassword") };
    }
    if (proof.proof === "totp") {
        return (await verifyTotpForSession(auth, await headers(), proof.code))
            ? {}
            : { error: (await readerWords("accountSecurity"))("known.wrongCode") };
    }
    return verifyStepUpCode(auth, userId, purpose, proof.code);
}

function minutes(ms: number): number {
    return Math.max(1, Math.ceil(ms / 60000));
}
