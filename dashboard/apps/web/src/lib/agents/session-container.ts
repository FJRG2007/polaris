/**
 * The container a container session runs in, wherever it was placed.
 *
 * One spec for both of the ways one comes up: a session started straight away
 * (`SESSION_BOOT`, its environment in the container's) and a spare started
 * ahead of it (`SPARE_BOOT`, its environment written later - see
 * `session-spares`). Shared so the two cannot drift on the mounts, the limits
 * or the name the rest of the runtime finds the container by.
 */

import * as commands from "./session-commands";
import { sessionNetworks } from "./session-network";
import { upWithFreshImage } from "./session-image";
import { sessionLimits } from "./session-capacity";
import { withContainerPorts } from "./session-ports";

/** Stamped on every session container, so the sweep finds them by label. */
export const LABEL_KEY = "polaris.agent-session";

/** Said by the daemon when the box has no address range left for a network. */
function networkRefused(error: unknown): boolean {
    return error instanceof Error && /could not create network/i.test(error.message);
}

/** What decides where a container goes and whose home it opens on. */
export interface ContainerTarget {
    readonly id: string;
    /** The pool server, or null for this box. See `session-placement`. */
    readonly hostId: string | null;
    readonly ownerId: string | null;
    readonly sharedHome: boolean;
}

/** Bring the container up with `env` and `script`. */
export async function startContainer(
    target: ContainerTarget,
    env: Record<string, string>,
    script: string
): Promise<void> {
    const name = commands.sessionContainerName(target.id);
    const limits = await sessionLimits();
    const hostId = target.hostId;
    const up = (networks: string[]) =>
        upWithFreshImage(
            (pullPolicy) =>
                withContainerPorts(hostId, (ports) =>
                    ports.composeUp({
                        project: name,
                        services: [
                            {
                                name,
                                image: commands.SESSION_IMAGE,
                                pullPolicy,
                                env,
                                ports: [],
                                // The one thing that outlives the session. See `AGENT_HOME`:
                                // the sign-in, the installed tools and Enigma's own settings
                                // live here, per account, so the second session starts signed in
                                // and in seconds rather than minutes.
                                volumes: [
                                    {
                                        // The machine everybody shares, or this account's own.
                                        // Which of the two was settled when the session was
                                        // created and is stored on it, so it cannot change
                                        // under a session that is already running.
                                        //
                                        // Otherwise: whoever started it, which is whose
                                        // credentials the session spends. A session from before
                                        // that was recorded gets a home of its own rather than
                                        // joining a shared one - an empty key would put every
                                        // such session in the same directory, which is one
                                        // person's sign-in in another person's terminal.
                                        source: target.sharedHome
                                            ? commands.SHARED_HOME_SOURCE
                                            : commands.agentHomeSource(
                                                  target.ownerId ?? `session-${target.id}`
                                              ),
                                        target: commands.AGENT_HOME,
                                        kind: "bind" as const
                                    },
                                    // The checkout and Polaris's files for it, on the box
                                    // rather than in the container's own layer, so a
                                    // container that is recreated comes back to the same
                                    // work. Removed when the work has been saved.
                                    {
                                        source: commands.sessionCheckoutSource(target.id),
                                        target: commands.SESSION_ROOT,
                                        kind: "bind" as const
                                    }
                                ],
                                labels: { [LABEL_KEY]: target.id },
                                command: commands.bootArgv(script),
                                networks,
                                // Back after a reboot of the box. The checkout is on the
                                // box, so the boot finds it and reopens on it rather than
                                // cloning over it - see PREPARE_WORKTREE - and the agent
                                // comes back on the conversation it was in.
                                restart: "unless-stopped",
                                // Bounded, so one session building something enormous slows
                                // itself rather than every app on the box. See
                                // `sessionLimits` for where the numbers come from.
                                cpus: limits.cpus,
                                memoryMb: limits.memoryMb
                            }
                        ],
                        volumes: [],
                        networks
                    })
                ),
            () => withContainerPorts(hostId, (ports) => ports.pull(commands.SESSION_IMAGE)),
            Date.now,
            hostId ?? undefined
        );
    const networks = sessionNetworks(target);
    try {
        await up(networks);
    } catch (error) {
        // A box out of address ranges still starts the session; only its
        // preview is missing, and the workspace says so.
        if (networks.length === 0 || !networkRefused(error)) throw error;
        console.error(`[agent-session] ${target.id}: started without its own network:`, error);
        await up([]);
    }
}
