"use server";

/**
 * Reading and answering a command-line client's request to be signed in.
 *
 * Both require a signed-in account, which is the whole of what approving one
 * proves: the CLI holds nothing until somebody already inside Polaris says so,
 * in a browser Polaris can see. Modelled on the extension's own
 * (`account/extension/actions.ts`), throttle and audit included.
 */

import { requireUser } from "@/lib/session";
import type { PendingCliSignIn } from "@/lib/cli/sign-in";
import { answerSignInFor, describeSignInFor } from "@/lib/cli/approval";

/**
 * The request behind a code, for the screen that shows it - with the scopes cut
 * to what this account holds, so the screen lists what the key will really be
 * able to do rather than what the CLI asked for.
 */
export async function describeCliSignInAction(
    typed: unknown,
    askedKind?: unknown
): Promise<{ pending?: PendingCliSignIn; error?: string }> {
    return describeSignInFor(await requireUser(), typed, askedKind);
}

/** Sign it in, or turn it away. */
export async function answerCliSignInAction(
    input: unknown
): Promise<{ ok?: true; error?: string }> {
    return answerSignInFor(await requireUser(), input);
}
