/**
 * The machine a pool runs its jobs on, whichever machine that is.
 *
 * Polaris reaches a registered server over SSH and the box it runs on through the
 * host daemon, and those are genuinely different: one has a login that can be
 * given a directory to work in, the other only has a container engine on the far
 * side of an allowlist. Everything above this file - the reconciler, the pool
 * service - should not have to know which it is holding, so both are driven
 * through one interface and picked once, here.
 */

import { RunnerHost } from "./runner-host";
import type { RunnerRelease } from "./runner-release";
import { LocalRunnerHost } from "./local-runner-host";
import { LOCAL_SERVER_ID, type MachineResources, type RunnerIsolation } from "@polaris/core";

/** Where one ephemeral runner can be found again on the machine. */
export interface RunnerHandle {
    readonly isolation: RunnerIsolation;
    /** Container name, or the pid of the detached process. */
    readonly handle: string;
}

/** What the machine turned out to be, asked rather than remembered: a container
 *  engine can be installed, removed, or have its group membership revoked long
 *  after the machine was enrolled. */
export interface RunnerProbe {
    readonly platform: string;
    readonly arch: string;
    readonly containerEngine: boolean;
    readonly resources: MachineResources;
}

export interface RunnerMachine {
    /** How Polaris drives it, which decides what isolation it can offer. */
    readonly reach: "login" | "engine";
    probe(): Promise<RunnerProbe>;
    /** Put what a job will need in place, before any registration is minted. */
    prepare(release: RunnerRelease, isolation: RunnerIsolation): Promise<void>;
    start(input: {
        name: string;
        isolation: RunnerIsolation;
        release: RunnerRelease;
        jitConfig: string;
    }): Promise<RunnerHandle>;
    isAlive(runner: RunnerHandle): Promise<boolean>;
    /** Take a finished runner off the machine and return what it said on its way
     *  out - the only account of why one that never registered gave up. */
    reap(name: string, runner: RunnerHandle): Promise<string>;
    /** Remove whatever no live runner accounts for. */
    sweep(live: readonly string[]): Promise<void>;
    close(): void;
}

/** Open the machine a pool runs on. `serverId` is a Host id, or "local" for the
 *  box Polaris runs on. */
export async function openRunnerMachine(serverId: string, ownerId: string): Promise<RunnerMachine> {
    return serverId === LOCAL_SERVER_ID ? LocalRunnerHost.open() : RunnerHost.open(serverId, ownerId);
}

/** The server a stored pool points at. A null hostId is the local box, the same
 *  way a deploy target of kind "local" carries no host. */
export function poolServerId(hostId: string | null): string {
    return hostId ?? LOCAL_SERVER_ID;
}
