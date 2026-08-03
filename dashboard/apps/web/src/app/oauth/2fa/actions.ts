"use server";

/**
 * Leaving the challenge without finishing it. Nothing here is privileged: the
 * only thing it can reach is the challenge cookie the caller's own browser sent,
 * and dropping it is always allowed - it takes a sign-in away rather than
 * granting one.
 *
 * enigma:allow-unlimited-auth - this is not a guessing surface. It accepts no
 * identifier and verifies nothing: it deletes the challenge the caller already
 * holds a signed cookie for, so there is no secret to guess, no account to
 * enumerate, and nothing a repeat call reaches that the first one did not.
 */

import { redirect } from "next/navigation";
import { clearPendingTwoFactor } from "@/lib/two-factor-challenge";

export async function abandonChallengeAction(): Promise<never> {
    await clearPendingTwoFactor();
    redirect("/oauth/login");
}
