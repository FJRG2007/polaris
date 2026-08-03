/**
 * Driving the runner on somebody else's machine, over the same SSH connection
 * every other part of Polaris uses to reach a server.
 *
 * There is no Polaris agent to install. A registered Host already carries a
 * password-less login, an envelope-encrypted key and a pinned host key, so a runner
 * is started the way a person would start one: connect, verify the machine is who
 * it says it is, run a short POSIX script. That keeps one audited path onto the
 * machine instead of a second one nobody reviews.
 *
 * Two things are deliberate:
 *
 *   - The JIT configuration never appears on a command line. sshd runs what it is
 *     given through a shell, and that command is readable in `ps` by every user on
 *     the box; the configuration authenticates as the runner until it is used, so
 *     it arrives on stdin and is read straight into a shell variable. The runner
 *     itself masks it in its own logs.
 *   - Nothing is trusted to have stayed put. The tarball's checksum is re-verified
 *     against the one GitHub published even when the file is already cached, and a
 *     runner's liveness is probed on the machine rather than inferred from what
 *     Polaris last recorded.
 */

import type { Client } from "ssh2";
import { quoteArg } from "@polaris/deploy";
import type { RunnerRelease } from "./runner-release";
import { execCommand, openSshClient } from "@polaris/ssh";
import { getHostConnection, type HostConnection } from "@/lib/host-service";
import { factsFromLog, JOB_FACTS_FILE, parseJobFacts, type RunnerIsolation } from "@polaris/core";
import {
    CONTAINER_RUNNER_ROOT,
    type RunnerHandle,
    type RunnerMachine,
    type RunnerProbe,
    type RunnerRemains,
    type RunnerStart
} from "./runner-machine";

/** Everything Polaris puts on a machine lives under one directory, so removing a
 *  server from Polaris leaves one thing to delete. */
const ROOT = "\"$HOME\"/.polaris/runners";

/** Stamped on every container a runner pool starts. The sweep matches on this
 *  rather than on the name: the machines Polaris runs jobs on are frequently the
 *  same ones it deploys applications to, and a name prefix is not a good enough
 *  reason to remove somebody's running service. */
const RUNNER_LABEL = "polaris.runner=1";

/** How much of a command's output is kept. Enough for a stack of runner log lines,
 *  bounded so a runaway command cannot be answered with a gigabyte. */
const MAX_OUTPUT = 8000;

/** A runner starting from cold pulls a ~200 MB tarball or a container image. */
const PREPARE_TIMEOUT_MS = 10 * 60 * 1000;

export interface RunResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

/**
 * An open session on a machine that runs jobs. Held for the length of one
 * reconcile pass over a pool, so filling four slots costs one SSH handshake.
 */
export class RunnerHost implements RunnerMachine {
    /** A registered server is driven through a login, which is what makes a
     *  workspace job - a directory on the machine itself - possible at all. */
    public readonly reach = "login" as const;

    private constructor(private readonly client: Client) {}

    /** Connect to a registered server. Fails closed on the host key, like every
     *  other connection Polaris makes. */
    public static async open(hostId: string, ownerId: string): Promise<RunnerHost> {
        return RunnerHost.connect(await getHostConnection(hostId, ownerId));
    }

    /** Connect with credentials already in hand, so where they came from stays the
     *  caller's business and this class only ever deals in what to do once there. */
    public static async connect(host: HostConnection): Promise<RunnerHost> {
        const client = await openSshClient({
            host: host.address,
            port: host.port,
            username: host.username,
            auth: host.auth,
            pinnedHostKey: host.hostKey
        });
        return new RunnerHost(client);
    }

    public close(): void {
        this.client.end();
    }

    /** Run a POSIX script, optionally feeding it a secret on stdin. */
    private async run(script: string, input?: string): Promise<RunResult> {
        let stdout = "";
        let stderr = "";
        const result = await execCommand(this.client, script, {
            input,
            onStdout: (chunk) => {
                if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
            },
            onStderr: (chunk) => {
                if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
            }
        });
        return { code: result.code, stdout: stdout.trim(), stderr: stderr.trim() };
    }

    /**
     * What the machine can actually offer right now. Asked rather than remembered:
     * a container engine can be installed, removed, or have its group membership
     * revoked long after the machine was enrolled, and the disk it would build in
     * fills up without anybody telling Polaris.
     *
     * Every reading is optional. Each one falls back to the next way of asking and
     * then to nothing, because a machine that will not say how much memory it has
     * is still a machine that can run a job - it just cannot be sized.
     */
    public async probe(): Promise<RunnerProbe> {
        const result = await this.run(`echo "platform=$(uname -s | tr "[:upper:]" "[:lower:]")"
echo "arch=$(uname -m)"
if docker info >/dev/null 2>&1; then echo engine=yes; else echo engine=no; fi
echo "cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0)"
MEM=$(awk '/^MemTotal:/ {print $2 * 1024}' /proc/meminfo 2>/dev/null || true)
[ -n "$MEM" ] || MEM=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
echo "memory=$MEM"
echo "disk=$(df -Pk "$HOME" 2>/dev/null | awk 'NR == 2 {print $4 * 1024}')"`);

        const read = (key: string): string => new RegExp(`^${key}=(.*)$`, "m").exec(result.stdout)?.[1]?.trim() ?? "";
        const count = (key: string): number => {
            const value = Number(read(key));
            return Number.isFinite(value) && value > 0 ? value : 0;
        };
        return {
            platform: read("platform"),
            arch: read("arch"),
            containerEngine: read("engine") === "yes",
            resources: {
                cpus: count("cpus"),
                memoryBytes: count("memory"),
                diskFreeBytes: count("disk") || null
            }
        };
    }

    /**
     * Put what a job will need on the machine, before any registration is minted.
     * Doing it first means a machine that cannot download the runner never causes a
     * runner to be registered with GitHub and immediately abandoned.
     */
    public async prepare(release: RunnerRelease, isolation: RunnerIsolation): Promise<void> {
        const result =
            isolation === "container" ? await this.pullImage(release) : await this.cacheTarball(release);
        if (result.code !== 0) throw new Error(prepareError(result, isolation));
    }

    private async pullImage(release: RunnerRelease): Promise<RunResult> {
        return this.runWithTimeout(`docker pull ${quoteArg(release.image)} >/dev/null`, PREPARE_TIMEOUT_MS);
    }

    /**
     * Download the runner and verify it against the checksum GitHub published with
     * the release. An already-cached file is verified again rather than trusted:
     * the cheap alternative is believing whatever is at that path, which is exactly
     * what a half-finished download from last week looks like.
     */
    private async cacheTarball(release: RunnerRelease): Promise<RunResult> {
        const script = `set -eu
CACHE=${ROOT}/cache
FILE="$CACHE"/${quoteArg(release.assetName)}
SHA=${quoteArg(release.sha256)}

verify() {
    if command -v sha256sum >/dev/null 2>&1; then
        printf '%s  %s\\n' "$SHA" "$1" | sha256sum -c - >/dev/null 2>&1
    else
        printf '%s  %s\\n' "$SHA" "$1" | shasum -a 256 -c - >/dev/null 2>&1
    fi
}

mkdir -p "$CACHE"
if [ -f "$FILE" ]; then
    if verify "$FILE"; then exit 0; fi
    rm -f "$FILE"
fi

command -v curl >/dev/null 2>&1 || { echo "curl is not installed on this machine" >&2; exit 1; }
curl -fsSL --retry 3 -o "$FILE".part ${quoteArg(release.downloadUrl)}
if ! verify "$FILE".part; then
    rm -f "$FILE".part
    echo "the downloaded runner did not match the checksum GitHub published" >&2
    exit 1
fi
mv "$FILE".part "$FILE"`;
        return this.runWithTimeout(script, PREPARE_TIMEOUT_MS);
    }

    /**
     * Start one ephemeral runner. `jitConfig` authenticates as that runner until it
     * is used, so it goes in on stdin and never onto a command line.
     */
    public async start(input: RunnerStart): Promise<RunnerHandle> {
        const result =
            input.isolation === "container" ? await this.startContainer(input) : await this.startOnMachine(input);

        if (result.code !== 0 || !result.stdout) {
            throw new Error(result.stderr || result.stdout || "The machine did not start the runner");
        }
        return { isolation: input.isolation, handle: input.isolation === "container" ? input.name : result.stdout };
    }

    /**
     * A container per job. The host's container socket is deliberately NOT mounted
     * in: a job that can reach the engine can start a privileged container on the
     * machine, which would undo the whole point of running it in one. Workflow
     * steps that expect a container engine of their own fail here, and the pool
     * says so rather than trading the boundary away for them.
     *
     * It is not started with `--rm`. A container that removes itself takes its log
     * with it, and the log of a runner that exited without ever taking a job is the
     * only account of why; Polaris removes it when it reaps it instead.
     *
     * Nothing sensitive touches a command line. The configuration, the guard and
     * the secrets all arrive on stdin: the configuration and the guard become
     * environment values of this shell and are handed over with a bare `-e NAME`,
     * and the secrets become a file passed as `--env-file`. Spelling any of them
     * `-e NAME=value` would put them in `ps`, which every user on the box reads.
     *
     * The guard is base64 on the way in and is written *inside* the container by
     * the command that starts the runner - it is a multi-line script, and this
     * machine's filesystem is not the container's.
     */
    private async startContainer(input: RunnerStart): Promise<RunResult> {
        const guardPath = `${CONTAINER_RUNNER_ROOT}/polaris-guard.sh`;
        // Written, made executable and pointed at; then the runner replaces this
        // shell, so nothing of the bootstrap survives into the job.
        const boot = [
            `printf '%s' "$POLARIS_JOB_GUARD" | base64 -d > ${guardPath}`,
            `chmod 700 ${guardPath}`,
            "unset POLARIS_JOB_GUARD",
            `export ACTIONS_RUNNER_HOOK_JOB_STARTED=${guardPath}`,
            "exec ./run.sh"
        ].join("; ");

        const script = `set -eu
${READ_PAYLOAD}
ENVF=${ROOT}/live/${quoteArg(`${input.name}.env`)}
mkdir -p ${ROOT}/live
# The engine reads this file as it starts the container and never again, so it is
# removed immediately afterwards - it holds every secret the job may read, on a
# machine other people can usually log in to.
(umask 077 && printf '%s' "$POLARIS_JOB_ENV" | base64 $B64 > "$ENVF")
docker rm -f ${quoteArg(input.name)} >/dev/null 2>&1 || true
docker run -d --name ${quoteArg(input.name)} --label ${quoteArg(RUNNER_LABEL)} \\
    -e ACTIONS_RUNNER_INPUT_JITCONFIG -e POLARIS_JOB_GUARD --env-file "$ENVF" \\
    ${quoteArg(input.release.image)} sh -c ${quoteArg(boot)} >/dev/null 2>&1 || { rm -f "$ENVF"; echo "the container engine would not start the runner" >&2; exit 1; }
rm -f "$ENVF"
printf '%s' ${quoteArg(input.name)}`;
        return this.run(script, payload(input.jitConfig, input.guard, envFile(input.secrets)));
    }

    /**
     * A fresh extract of the runner per job, on the machine itself. Two runners
     * cannot share one directory - the runner writes its registration and its
     * diagnostics into it - and a per-job copy is also what makes this a clean
     * slate rather than a directory the last job left something in.
     *
     * The secrets go into the runner's own `.env`, which is the documented way to
     * put a value in reach of a job's steps, and it is written before the runner
     * starts because the runner only reads it once.
     */
    private async startOnMachine(input: RunnerStart): Promise<RunResult> {
        const script = `set -eu
DIR=${ROOT}/live/${quoteArg(input.name)}
rm -rf "$DIR"
mkdir -p "$DIR"
tar xzf ${ROOT}/cache/${quoteArg(input.release.assetName)} -C "$DIR"

${READ_PAYLOAD}
# The runner reads .env once, at startup, so both of these are in place before it
# is started. The hook is pointed at by absolute path, which only the machine can
# spell - .env is a plain list of names and values and expands nothing.
(umask 077 && printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s\\n' "$DIR/polaris-guard.sh" > "$DIR"/.env)
printf '%s' "$POLARIS_JOB_ENV" | base64 $B64 >> "$DIR"/.env
printf '%s' "$POLARIS_JOB_GUARD" | base64 $B64 > "$DIR"/polaris-guard.sh
chmod 700 "$DIR"/polaris-guard.sh

cd "$DIR"
# nohup, not a service: the runner takes one job and exits, so it has to outlive
# this SSH channel without ever being something the machine restarts.
nohup ./run.sh >"$DIR"/polaris.log 2>&1 </dev/null &
printf '%s' "$!"`;
        return this.run(script, payload(input.jitConfig, input.guard, envFile(input.secrets)));
    }

    /** Whether a runner Polaris started is still there. Probed, because the answer
     *  changes without anybody telling Polaris. */
    public async isAlive(runner: RunnerHandle): Promise<boolean> {
        if (runner.isolation === "container") {
            const result = await this.run(
                `docker inspect -f '{{.State.Running}}' ${quoteArg(runner.handle)} 2>/dev/null || true`
            );
            return result.stdout === "true";
        }
        if (!/^\d+$/.test(runner.handle)) return false;
        const result = await this.run(`kill -0 ${runner.handle} 2>/dev/null && echo alive || true`);
        return result.stdout === "alive";
    }

    /**
     * Take a finished runner off the machine and report what it left behind.
     *
     * Two things are wanted and both are gone a moment later. The log is why a
     * runner that never registered gave up, which nothing else records. The job
     * record is what the runner actually ran, which GitHub cannot be asked for
     * afterwards - an ephemeral runner de-registers itself as its job ends.
     *
     * They are collected in the same round trip as the removal, because the
     * removal is what destroys them.
     */
    public async reap(name: string, runner: RunnerHandle): Promise<RunnerRemains> {
        if (runner.isolation === "container") {
            // The record is fished out of the container's own log: the guard prints
            // it to process 1's output for exactly this, since a stopped container
            // is not somewhere a file can be read from without more privilege than
            // this needs.
            const result = await this.run(
                `docker logs --tail 200 ${quoteArg(runner.handle)} 2>&1 | tail -c 8000 || true
docker rm -f ${quoteArg(runner.handle)} >/dev/null 2>&1 || true`
            );
            return { log: tailLines(result.stdout), facts: factsFromLog(result.stdout) };
        }

        const script = `DIR=${ROOT}/live/${quoteArg(name)}
${/^\d+$/.test(runner.handle) ? `kill ${runner.handle} 2>/dev/null || true` : "true"}
if [ -f "$DIR"/${quoteArg(JOB_FACTS_FILE)} ]; then
    printf '%s\\n' ${quoteArg(FACTS_BOUNDARY)}
    cat "$DIR"/${quoteArg(JOB_FACTS_FILE)}
    printf '%s\\n' ${quoteArg(FACTS_BOUNDARY)}
fi
[ -f "$DIR"/polaris.log ] && tail -c 2000 "$DIR"/polaris.log || true
rm -rf "$DIR"`;
        const result = await this.run(script);
        return splitRemains(result.stdout);
    }

    /**
     * Remove what no live runner accounts for. A machine that was rebooted, or a
     * Polaris that was restarted mid-pass, leaves stopped containers and extracted
     * runner directories that nothing will ever come back for.
     *
     * `live` is the set of runner names Polaris still expects to find; anything
     * else under its own directory, or carrying its own container label, is gone.
     */
    public async sweep(live: readonly string[]): Promise<void> {
        const keep = new Set(live);
        const listed = await this.run(
            `docker ps -a --filter label=${quoteArg(RUNNER_LABEL)} --format '{{.Names}}' 2>/dev/null || true
ls -1 ${ROOT}/live 2>/dev/null || true`
        );

        // Both listings are names, and the same runner can have left one of each
        // behind, so they are collected together and removed both ways.
        const stale = new Set<string>();
        for (const line of listed.stdout.split("\n").map((value) => value.trim())) {
            if (line && !keep.has(line) && /^polaris-[a-z0-9-]+$/.test(line)) stale.add(line);
        }
        if (stale.size === 0) return;

        const names = [...stale].map(quoteArg).join(" ");
        const dirs = [...stale].map((name) => `${ROOT}/live/${quoteArg(name)}`).join(" ");
        await this.run(`docker rm -f ${names} >/dev/null 2>&1 || true
rm -rf ${dirs}`);
    }

    /** A command that may legitimately take minutes. The connection is abandoned
     *  rather than waited on forever, so one stuck download cannot wedge the loop. */
    private async runWithTimeout(script: string, timeoutMs: number): Promise<RunResult> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                this.run(script),
                new Promise<RunResult>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error("The machine took too long to answer")), timeoutMs);
                })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}

/**
 * The preamble every start script begins with: read what came in on stdin.
 *
 * Everything sensitive arrives this way rather than on a command line, because
 * sshd runs what it is given through a shell and that command is readable in
 * `ps` by every user on the box. Three lines, in order: the registration, the
 * guard, and the environment file - the last two base64 so a multi-line script
 * and a list of values stay one line each on the way in.
 *
 * `base64 -d` is GNU's spelling and `-D` is the BSD one that macOS ships. Which
 * one this machine has is settled once, by trying it, rather than guessed from
 * the platform.
 */
const READ_PAYLOAD = `IFS= read -r JIT
IFS= read -r POLARIS_JOB_GUARD
IFS= read -r POLARIS_JOB_ENV
[ -n "$JIT" ] || { echo "no runner configuration was passed" >&2; exit 1; }
export ACTIONS_RUNNER_INPUT_JITCONFIG="$JIT"
export POLARIS_JOB_GUARD
if printf 'cG9sYXJpcw==' | base64 -d >/dev/null 2>&1; then B64="-d"; else B64="-D"; fi`;

/** What is fed to that preamble, in the order it reads them. */
function payload(jitConfig: string, guard: string, env: string): string {
    const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64");
    return `${jitConfig}\n${encode(guard)}\n${encode(env)}\n`;
}

/** The secrets as the runner and the container engine both read them: one name
 *  and value per line, no quoting and no expansion. Values are single-line by
 *  the time they get here, which is what makes that format sufficient. */
function envFile(secrets: Readonly<Record<string, string>>): string {
    const lines = Object.entries(secrets).map(([name, value]) => `${name}=${value}`);
    return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** Marks the job record inside the reap script's output, so one round trip can
 *  carry both it and the log without either being mistaken for the other. */
const FACTS_BOUNDARY = "--polaris-facts--";

/** Split a reap's output back into the record and the log. */
function splitRemains(output: string): RunnerRemains {
    const parts = output.split(FACTS_BOUNDARY);
    if (parts.length < 3) return { log: tailLines(output), facts: null };
    return { log: tailLines(`${parts[0] ?? ""}${parts.slice(2).join(FACTS_BOUNDARY)}`), facts: parseJobFacts(parts[1] ?? "") };
}

/** The last of a log, which is the part that says why. */
function tailLines(output: string): string {
    return output.trim().slice(-2000);
}

/** Turn a failed preparation into something that names what to fix. */
function prepareError(result: RunResult, isolation: RunnerIsolation): string {
    const detail = result.stderr || result.stdout;
    if (isolation === "container" && /permission denied|cannot connect to the docker daemon/i.test(detail)) {
        return "The Polaris login on this machine cannot reach the container engine. Re-run the enrollment command with --docker.";
    }
    if (/checksum/i.test(detail)) return detail;
    return detail || "The machine could not prepare the runner";
}
