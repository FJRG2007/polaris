/**
 * Running jobs on the box Polaris itself runs on.
 *
 * There is no SSH login here and there is deliberately no shell: the web
 * container reaches this machine only through polaris-hostd, which starts
 * validated compose projects and forwards a short allowlist of read calls to the
 * container engine. That is the same path a deployed application takes, and it is
 * why the local machine can only offer contained jobs - nothing here can hand a
 * job a directory on the host and a login to run under, which is exactly the
 * boundary worth keeping on the machine the control plane lives on.
 *
 * One runner is one compose project of one container, named after the runner, so
 * every later question - is it alive, what did it say, is it stale - is asked
 * about a container name Polaris chose.
 */

import type { OutputSink } from "@polaris/deploy";
import { HostdClient } from "@polaris/hostd-client";
import { HostdPorts } from "@/lib/deploy/ports-hostd";
import type { RunnerRelease } from "./runner-release";
import { factsFromLog, type MachineResources, type RunnerIsolation } from "@polaris/core";
import {
    CONTAINER_RUNNER_ROOT,
    type RunnerHandle,
    type RunnerMachine,
    type RunnerProbe,
    type RunnerRemains,
    type RunnerStart
} from "./runner-machine";

/** Stamped on every container a runner pool starts, so a sweep can find them
 *  without matching on names it does not own. */
const RUNNER_LABEL_KEY = "polaris.runner";
const RUNNER_LABEL = `${RUNNER_LABEL_KEY}=1`;

/** How much of a reaped runner's log is kept. Enough for the line that says why
 *  it gave up, bounded so a chatty runner cannot be answered with a megabyte. */
const MAX_LOG = 2000;

/** How much of it is read before that. The record of what the job was is printed
 *  early and the runner keeps talking afterwards, so the search for it needs more
 *  room than the excerpt that is kept. */
const MAX_READ = 16_000;

/** Only a runner Polaris named is ever removed by a sweep. */
const RUNNER_NAME = /^polaris-[a-z0-9-]+$/;

/** The fields of Docker's /info this needs, all optional: the reply is untrusted
 *  and an engine that omits one must not take the probe down. */
interface EngineInfo {
    OSType?: unknown;
    Architecture?: unknown;
    NCPU?: unknown;
    MemTotal?: unknown;
}

export class LocalRunnerHost implements RunnerMachine {
    public readonly reach = "engine" as const;

    private readonly client = new HostdClient();
    private readonly ports = new HostdPorts();

    /** Nothing is opened: every call is a request to the daemon. Kept async and
     *  named like the SSH driver's so the factory reads the same either way. */
    public static async open(): Promise<LocalRunnerHost> {
        return new LocalRunnerHost();
    }

    public close(): void {
        // No connection is held open.
    }

    /**
     * What the machine is and what it has. The engine is the only thing here that
     * can answer, so an engine that does not reply reads as a machine with no
     * container engine - which is the truth as far as running a job goes.
     */
    public async probe(): Promise<RunnerProbe> {
        const empty: MachineResources = { cpus: 0, memoryBytes: 0, diskFreeBytes: null };
        try {
            const info = await this.info();
            return {
                platform: typeof info.OSType === "string" ? info.OSType.toLowerCase() : "",
                arch: typeof info.Architecture === "string" ? info.Architecture.toLowerCase() : "",
                containerEngine: true,
                resources: {
                    cpus: typeof info.NCPU === "number" ? info.NCPU : 0,
                    memoryBytes: typeof info.MemTotal === "number" ? info.MemTotal : 0,
                    // The engine does not report free disk and the daemon's proxy
                    // allowlist has nothing that does; unmeasured, not zero.
                    diskFreeBytes: null
                }
            };
        } catch {
            return { platform: "", arch: "", containerEngine: false, resources: empty };
        }
    }

    public async prepare(release: RunnerRelease, isolation: RunnerIsolation): Promise<void> {
        assertContained(isolation);
        const output = collect();
        try {
            await this.ports.pull(release.image, output.write);
        } catch (caught) {
            throw new Error(failure(`Could not pull ${release.image} on this machine`, caught, output.tail()));
        }
    }

    /**
     * Start one runner as its own compose project.
     *
     * The registration goes in as an environment value, which the daemon renders
     * into the project's compose file. That file is the same one every deployed
     * application's environment already goes through, and this particular secret
     * is spent the moment the runner takes its job; the reap below removes the
     * project, and a runner that never started has its registration deleted from
     * GitHub by the reconciler, which is what actually invalidates it.
     */
    public async start(input: RunnerStart): Promise<RunnerHandle> {
        assertContained(input.isolation);
        const output = collect();
        await this.startProject(input, output).catch((caught: unknown) => {
            throw new Error(failure("The machine did not start the runner", caught, output.tail()));
        });
        return { isolation: "container", handle: input.name };
    }

    /**
     * The guard rides in base64-encoded and is written by the command that starts
     * the runner.
     *
     * It has to: a compose environment value is rendered into a YAML scalar on one
     * line, and the guard is a multi-line script. Encoding it makes it one line,
     * and the container writes it back out before replacing the shell with the
     * runner - so nothing of the bootstrap is left in the job's environment.
     */
    private async startProject(
        input: RunnerStart,
        output: { write: OutputSink; tail: () => string }
    ): Promise<void> {
        const guardPath = `${CONTAINER_RUNNER_ROOT}/polaris-guard.sh`;
        const boot = [
            `printf '%s' "$POLARIS_JOB_GUARD" | base64 -d > ${guardPath}`,
            `chmod 700 ${guardPath}`,
            "unset POLARIS_JOB_GUARD",
            `export ACTIONS_RUNNER_HOOK_JOB_STARTED=${guardPath}`,
            "exec ./run.sh"
        ].join("; ");

        await this.ports.composeUp(
            {
                project: input.name,
                services: [
                    {
                        name: input.name,
                        image: input.release.image,
                        env: {
                            ACTIONS_RUNNER_INPUT_JITCONFIG: input.jitConfig,
                            POLARIS_JOB_GUARD: Buffer.from(input.guard, "utf8").toString("base64"),
                            ...input.secrets
                        },
                        ports: [],
                        volumes: [],
                        labels: { [RUNNER_LABEL_KEY]: "1" },
                        command: ["sh", "-c", boot],
                        networks: [],
                        // Never restarted: this runner exists to take one job and go.
                        // A restart policy would bring back a runner whose registration
                        // is already spent, to sit there failing to connect.
                        restart: "no"
                    }
                ],
                volumes: [],
                networks: []
            },
            output.write
        );
    }

    public async isAlive(runner: RunnerHandle): Promise<boolean> {
        const response = await this.client
            .dockerRequest("GET", `/containers/${encodeURIComponent(runner.handle)}/json`)
            .catch(() => null);
        if (!response || response.status !== 200) return false;
        try {
            const state = (JSON.parse(response.body) as { State?: { Running?: unknown } }).State;
            return state?.Running === true;
        } catch {
            return false;
        }
    }

    /**
     * The log is the only thing that survives a container here: the daemon
     * forwards a short allowlist of read calls and nothing that fetches a file
     * out of one. That is why the guard prints its record to process 1's output
     * as well as writing it - this is where it is read back from.
     */
    public async reap(name: string, runner: RunnerHandle): Promise<RunnerRemains> {
        const log = await this.logs(runner.handle);
        // The project is removed even if the log could not be read: leaving it
        // behind would leave a stopped container and its compose file on the host.
        await this.ports.composeDown(name).catch(() => undefined);
        return { log: log.slice(-2000), facts: factsFromLog(log) };
    }

    public async sweep(live: readonly string[]): Promise<void> {
        const keep = new Set(live);
        const stale = (await this.runnerContainers()).filter((name) => !keep.has(name) && RUNNER_NAME.test(name));
        for (const name of stale) {
            await this.ports.composeDown(name).catch(() => undefined);
        }
    }

    /** Container names carrying the runner label, whatever state they are in. */
    private async runnerContainers(): Promise<string[]> {
        const filters = encodeURIComponent(JSON.stringify({ label: [RUNNER_LABEL] }));
        const response = await this.client
            .dockerRequest("GET", `/containers/json?all=1&filters=${filters}`)
            .catch(() => null);
        if (!response || response.status !== 200) return [];
        try {
            const containers = JSON.parse(response.body) as Array<{ Names?: unknown }>;
            if (!Array.isArray(containers)) return [];
            return containers.flatMap((container) =>
                Array.isArray(container.Names)
                    ? container.Names.filter((name): name is string => typeof name === "string").map((name) =>
                          name.replace(/^\//, "")
                      )
                    : []
            );
        } catch {
            return [];
        }
    }

    private async info(): Promise<EngineInfo> {
        const response = await this.client.dockerRequest("GET", "/info");
        if (response.status !== 200) throw new Error(`the container engine returned ${response.status}`);
        const parsed = JSON.parse(response.body) as unknown;
        if (typeof parsed !== "object" || parsed === null) throw new Error("the container engine returned no info");
        return parsed as EngineInfo;
    }

    /**
     * The tail of a container's log, best-effort: a container that is already gone
     * has no log, which is not a reason to fail the reap.
     *
     * Deliberately more than the few lines needed to see why a runner gave up. The
     * guard's record of what the job was is printed when the job is assigned, and
     * the runner is talkative afterwards, so a short tail would routinely lose it.
     */
    private async logs(container: string): Promise<string> {
        let collected = "";
        await this.ports
            .logs(
                container,
                (chunk) => {
                    if (collected.length < MAX_READ) collected += chunk.toString("utf8");
                },
                { tail: 200 }
            )
            .catch(() => undefined);
        return collected.slice(0, MAX_READ).trim();
    }
}

/** Keep what the daemon streamed, so a failure can report what the machine
 *  actually printed instead of only that a command exited non-zero. */
function collect(): { write: OutputSink; tail: () => string } {
    let text = "";
    return {
        write: (chunk) => {
            if (text.length < MAX_LOG) text += chunk.toString("utf8");
        },
        tail: () => text.slice(-500).trim()
    };
}

/** One message carrying both what failed and what the machine said about it. */
function failure(what: string, caught: unknown, output: string): string {
    const detail = caught instanceof Error ? caught.message : "";
    const said = output && output !== detail ? ` ${output}` : "";
    return `${what}${detail ? `: ${detail}` : ""}.${said}`.trim();
}

/** The local machine runs contained jobs or none: there is no login here to give
 *  a job a directory under. */
function assertContained(isolation: RunnerIsolation): void {
    if (isolation !== "container") {
        throw new Error(
            "Jobs on this machine can only run in containers - Polaris reaches it through its container engine, not through a login."
        );
    }
}
