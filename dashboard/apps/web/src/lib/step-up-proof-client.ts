/**
 * A step-up proof as a screen sends it (docs/chat-e2ee-phase1.md, "Password
 * flows over OPAQUE"): a typed password is proven over OPAQUE when the account
 * can, so it never leaves the browser; a code, and every fallback (an account
 * not moved yet, a worker that does not start, a host without the route), goes
 * exactly as it was typed. The OPAQUE code is loaded only when a password was
 * typed. `onStretching` fires when the key stretching is about to run, for the
 * slow-submit line.
 */

import type { StepUpProofInput } from "@polaris/core";
import type { AnyStepUpProof } from "@/lib/step-up";

export async function stepUpProofToSend(
    proof: StepUpProofInput,
    onStretching?: () => void
): Promise<AnyStepUpProof> {
    if (proof.proof !== "password") return proof;
    return import("@/lib/chat/e2ee/password-flows-client").then(
        (flows) => flows.sentStepUpProof(proof, onStretching),
        () => proof
    );
}
