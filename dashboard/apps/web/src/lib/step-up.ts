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
import { issueStepUpCode, verifyAccountPassword, verifyStepUpCode, verifyTotpForSession } from "@polaris/auth";
import {
    STEP_UP_PROOF_LABELS,
    TWO_FACTOR_CODE_TTL_MINUTES,
    type StepUpProof,
    type StepUpProofInput,
    type TwoFactorDeliveryMethod
} from "@polaris/core";

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
    method: TwoFactorDeliveryMethod
): Promise<{ error?: string }> {
    const { choices } = await stepUpOptions(userId);
    if (!choices.some((choice) => choice.proof === method)) {
        return { error: "That is not a way this account can confirm." };
    }

    const throttle = await rateLimit(`step-up-send:${userId}`, PROOF_LIMIT, PROOF_WINDOW_MS);
    if (!throttle.ok) {
        return { error: `Too many codes asked for. Try again in ${minutes(throttle.retryAfterMs)}.` };
    }

    const code = await issueStepUpCode(auth, userId, purpose);
    const result = await deliverCode(userId, method, {
        subject: "Your Polaris confirmation code",
        text: [
            `Your Polaris confirmation code is ${code}.`,
            "",
            `It expires in ${TWO_FACTOR_CODE_TTL_MINUTES} minutes and works once, for this one action.`,
            "If you did not ask to confirm anything, somebody else is using your session - change your password."
        ].join("\n"),
        html: [
            `<p>Your Polaris confirmation code is <strong>${code}</strong>.</p>`,
            `<p>It expires in ${TWO_FACTOR_CODE_TTL_MINUTES} minutes and works once, for this one action.</p>`,
            "<p>If you did not ask to confirm anything, somebody else is using your session - change your password.</p>"
        ].join("")
    });
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
    proof: StepUpProofInput
): Promise<{ error?: string }> {
    const throttle = await rateLimit(`step-up:${userId}`, PROOF_LIMIT, PROOF_WINDOW_MS);
    if (!throttle.ok) {
        return { error: `Too many attempts. Try again in ${minutes(throttle.retryAfterMs)}.` };
    }

    const { choices } = await stepUpOptions(userId);
    if (!choices.some((choice) => choice.proof === proof.proof)) {
        return { error: "That is not a way this account can confirm." };
    }

    const result = await check(userId, purpose, proof);
    await recordAudit({
        actorId: userId,
        action: result.error ? "account.step-up.failed" : "account.step-up.passed",
        metadata: { purpose, proof: proof.proof }
    });
    return result;
}

async function check(userId: string, purpose: string, proof: StepUpProofInput): Promise<{ error?: string }> {
    if (proof.proof === "password") {
        return (await verifyAccountPassword(auth, userId, proof.password))
            ? {}
            : { error: "That password is not right." };
    }
    if (proof.proof === "totp") {
        return (await verifyTotpForSession(auth, await headers(), proof.code))
            ? {}
            : { error: "That code is not right." };
    }
    return verifyStepUpCode(auth, userId, purpose, proof.code);
}

function minutes(ms: number): string {
    const count = Math.max(1, Math.ceil(ms / 60000));
    return `${count} minute${count === 1 ? "" : "s"}`;
}
