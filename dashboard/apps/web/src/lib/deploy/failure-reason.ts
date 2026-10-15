/**
 * Why a deployment ended without going live, in words the reader's language has.
 *
 * The reason is stored with the deployment once, in English, because it is written
 * by a process that has no reader. The fixed ones are named here so the code that
 * writes them and the screen that reads them agree on the exact text - including
 * rows written before this module existed, which carry the same strings. Anything
 * else (a builder's own message) is shown as it was stored.
 */

/** Written when Polaris came back up and found a deploy nothing was driving. */
// i18n-ignore stored with the deployment, written once in the default language
export const RESTARTED_REASON = "Polaris restarted while this deploy was running";
/** Written when someone stopped a deploy before it finished. */
// i18n-ignore stored with the deployment, written once in the default language
export const CANCELED_REASON = "Canceled";
/** Written when the runner failed with nothing that said why. */
// i18n-ignore stored with the deployment, written once in the default language
export const NO_REASON = "deploy failed";

/** Written when a deploy ran past its deadline and was stopped. */
export function timedOutReason(minutes: number): string {
    // i18n-ignore stored with the deployment, written once in the default language
    return `Stopped after ${minutes} minutes without finishing`;
}

const TIMED_OUT = /^Stopped after (\d+) minutes without finishing$/;

export type DeployFailureReason =
    | { kind: "restarted" }
    | { kind: "canceled" }
    | { kind: "timedOut"; minutes: number }
    | { kind: "noReason" }
    | { kind: "text"; text: string };

/** The states a deployment ends in without going live, so a reason belongs to it. */
export const UNSUCCESSFUL_DEPLOY_STATUSES: readonly string[] = [
    "failed",
    "cancelled",
    "rolled_back"
];

/**
 * Whether a deployment was stopped on purpose by someone, rather than by a
 * deadline or a fault: nothing went wrong, so nothing is offered to fix.
 */
export function stoppedByHand(status: string, error: string | null | undefined): boolean {
    return status === "cancelled" && (error?.trim() ?? "") === CANCELED_REASON;
}

/**
 * Read a deployment's stored reason. Null when the deployment did not fail, or when
 * it ended without going live for a reason it does not carry and no wording is
 * owed (a rollback that never wrote one).
 */
export function deployFailureReason(
    status: string,
    error: string | null | undefined
): DeployFailureReason | null {
    if (!UNSUCCESSFUL_DEPLOY_STATUSES.includes(status)) return null;
    const stored = error?.trim() ?? "";
    if (stored === RESTARTED_REASON) return { kind: "restarted" };
    if (stored === CANCELED_REASON) return { kind: "canceled" };
    if (stored === NO_REASON) return { kind: "noReason" };
    const timedOut = TIMED_OUT.exec(stored);
    if (timedOut) return { kind: "timedOut", minutes: Number(timedOut[1]) };
    if (stored) return { kind: "text", text: stored };
    return status === "failed" ? { kind: "noReason" } : null;
}
