/**
 * Whether Polaris turns a server's automatic security updates on by itself: once,
 * and only while nobody has ever chosen for that server. A person's "off" -
 * before or after Polaris armed it - is kept for good.
 */
export function armsUpdates(
    setting: { readonly updatesChoice: string | null; readonly updatesArmedAt: Date | null } | null
): boolean {
    return !setting || (setting.updatesChoice === null && setting.updatesArmedAt === null);
}

/** What a restart on this server would cut off, as the restart pass found it. */
export interface RestartBlockers {
    /** A game server there had players in the last day. */
    readonly players: boolean;
    /** A deploy there is queued, building or starting. */
    readonly deploying: boolean;
}

export type RestartStep = "schedule" | "ask" | "back" | null;

/**
 * What the updates pass does about a restart the updates need. Polaris
 * schedules it for 04:30 by itself, and says so, unless the restart would cut
 * off players or a deploy - then it asks. "back" is a server that needed one
 * and no longer does: it restarted and answered again, so the alert ends.
 * Once told, a server is not told again until the next restart is needed.
 */
export function restartStep(
    reboot: "none" | "required" | "scheduled" | null,
    notifiedAt: Date | null,
    blockers: RestartBlockers
): RestartStep {
    if (reboot === "none") return notifiedAt ? "back" : null;
    if (reboot !== "required" || notifiedAt) return null;
    return blockers.players || blockers.deploying ? "ask" : "schedule";
}

/** The words for what a restart would interrupt, as a message key. */
export function blockerReason(blockers: RestartBlockers): "reasonBoth" | "reasonPlayers" | "reasonDeploy" {
    if (blockers.players && blockers.deploying) return "reasonBoth";
    return blockers.players ? "reasonPlayers" : "reasonDeploy";
}
