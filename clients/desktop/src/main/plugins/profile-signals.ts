/**
 * What device plugin profiles switch on, looked at while a plugin has
 * profiles: a Polaris call and the running games (already in memory), and,
 * only while some profile has a rule on them, a meeting in another app (that
 * app has the microphone) and the app in front. Those two come from one glance
 * at the game watcher's open shell (`WindowsLister.glance`, Windows only): no
 * process is started per look, and none at all while no rule needs them.
 */

import type { Glance } from "../game-detect";
import { pluginProgramKey, type PluginProfileSignals } from "@polaris/core/device-plugins";

/** How often what is going on is looked at. The profile hold (2 s) is counted from these looks. */
export const PROFILE_TICK_MS = 1_000;
/** How often the shell is asked about the microphone and the app in front, while a rule needs it. */
export const PROFILE_GLANCE_MS = 2_000;

export interface ProfileSignalOptions {
    /** Whether a Polaris call is on. */
    readonly inCall: () => boolean;
    readonly games: () => readonly string[];
    /** Null where this system cannot be asked (not Windows). */
    readonly glance: (() => Promise<Glance>) | null;
    /** What the rules of every profile need looked at. */
    readonly needs: () => { readonly meeting: boolean; readonly front: boolean; };
    /** This app's own program, whose microphone is a Polaris call rather than a meeting elsewhere. */
    readonly ownPath: string;
    readonly push: (signals: PluginProfileSignals) => void;
    readonly now?: () => number;
}

/** The program using the microphone that is not this app, by its key, or null. */
export function meetingProgram(microphone: readonly string[], ownPath: string): string | null {
    const own = ownPath.toLowerCase();
    const other = microphone.find((program) => program.toLowerCase() !== own && pluginProgramKey(program) !== "");
    return other ? pluginProgramKey(other) : null;
}

/** One look every PROFILE_TICK_MS; answers the way to stop it. */
export function watchProfileSignals(options: ProfileSignalOptions, every: (tick: () => void, ms: number) => () => void): () => void {
    const now = options.now ?? Date.now;
    let glancedAt = -Infinity;
    let seen: { meeting: string | null; front: string | null; } = { meeting: null, front: null };
    let asking = false;

    const tick = () => {
        const needs = options.needs();
        if (!needs.meeting && !needs.front) seen = { meeting: null, front: null };
        else if (options.glance && !asking && now() - glancedAt >= PROFILE_GLANCE_MS) {
            glancedAt = now();
            asking = true;
            options
                .glance()
                .then((glance) => {
                    seen = { meeting: meetingProgram(glance.microphone, options.ownPath), front: glance.front };
                })
                // A shell that did not answer leaves the last look standing until the next one.
                .catch(() => undefined)
                .finally(() => {
                    asking = false;
                });
        }
        options.push({
            call: options.inCall(),
            meeting: needs.meeting ? seen.meeting : null,
            games: options.games(),
            front: needs.front ? seen.front : null
        });
    };
    tick();
    return every(tick, PROFILE_TICK_MS);
}
