/**
 * Where the connection stands, in the words Companion shows: the status badge
 * on the Connections page and the line in the connection's settings. Pure.
 */

import type { Phase } from "./connection";

/** The `InstanceStatus` member a phase is shown as. */
export type StatusName =
    "Ok" | "Connecting" | "BadConfig" | "AuthenticationFailure" | "ConnectionFailure";

export function phaseStatus(phase: Phase, account?: string): [StatusName, string | null] {
    switch (phase.phase) {
        case "unset":
            return ["BadConfig", "Type your Polaris address in this connection's settings."];
        case "invalid":
            return [
                "BadConfig",
                "That is not a web address. Type the address you open Polaris at."
            ];
        case "signing-in":
            return ["Connecting", `Approve code ${phase.userCode} at ${phase.url}`];
        case "sign-in-failed":
            return ["AuthenticationFailure", signInFailure(phase.reason)];
        case "connecting":
            return ["Connecting", null];
        case "online":
            return ["Ok", account ? `Signed in as ${account}` : null];
        case "offline":
            return ["ConnectionFailure", `Polaris could not be reached: ${phase.message}`];
        case "unauthorized":
            return [
                "AuthenticationFailure",
                'Signed out. Run the "sign in again" action, or save the settings, for a new code.'
            ];
    }
}

function signInFailure(reason: "denied" | "expired" | "unreachable"): string {
    if (reason === "denied")
        return "The code was refused in Polaris. Save the settings for a new one.";
    if (reason === "expired")
        return "The code ran out before it was approved. Save the settings for a new one.";
    return "Polaris could not be reached to sign in. Check the address and save the settings again.";
}

/** The line in the connection's settings. */
export function phaseText(phase: Phase, account: string | undefined): string {
    if (phase.phase === "online" || phase.phase === "connecting") {
        return account ? `Signed in as ${account}.` : "Signed in.";
    }
    if (phase.phase === "signing-in") {
        return `Open ${phase.url}, sign in and approve the code ${phase.userCode}.`;
    }
    return phaseStatus(phase)[1] ?? "";
}
