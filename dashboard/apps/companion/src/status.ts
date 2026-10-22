/**
 * Where the connection stands, in the words Companion shows: the status badge
 * on the Connections page and the line in the connection's settings. Pure.
 *
 * A newer module than this one is a warning on an otherwise healthy
 * connection: everything keeps working, and the status is where somebody
 * looking at Companion's Connections page will see it.
 */

import type { Phase } from "./connection";

/** The `InstanceStatus` member a phase is shown as. */
export type StatusName =
    | "Ok"
    | "Connecting"
    | "BadConfig"
    | "AuthenticationFailure"
    | "ConnectionFailure"
    | "UnknownWarning";

/** A newer module than this one, and the Downloads page of its Polaris offering it. */
export interface Update {
    readonly version: string;
    readonly url: string;
}

/** What the warning says. */
export function updateText(update: Update): string {
    return `Polaris for Companion ${update.version} is out. Download it from ${update.url} and import it on the Modules page.`;
}

export function phaseStatus(
    phase: Phase,
    account?: string,
    update?: Update | null
): [StatusName, string | null] {
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
            if (update) return ["UnknownWarning", updateText(update)];
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
export function phaseText(
    phase: Phase,
    account: string | undefined,
    update?: Update | null
): string {
    if (phase.phase === "online" || phase.phase === "connecting") {
        const signedIn = account ? `Signed in as ${account}.` : "Signed in.";
        return update ? `${signedIn} ${updateText(update)}` : signedIn;
    }
    if (phase.phase === "signing-in") {
        return `Open ${phase.url}, sign in and approve the code ${phase.userCode}.`;
    }
    return phaseStatus(phase)[1] ?? "";
}
