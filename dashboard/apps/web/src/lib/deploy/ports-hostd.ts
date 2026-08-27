/**
 * RuntimePorts backed by polaris-hostd for the local host. Every method maps to a
 * validated daemon endpoint - never a generic shell - so the local host keeps its
 * least-privilege posture: the daemon renders and validates the compose spec, and
 * only ever runs Polaris-shaped containers.
 */

import { Readable } from "node:stream";
import { HostdClient } from "@polaris/hostd-client";
import type { BuildRequest, ComposeSpec, ExecResult, ExecSpec, ExecStream, LogOptions, MountTarget, OutputSink, RuntimePorts } from "@polaris/deploy";
import { reclaimHostSpace } from "@/lib/deploy/host-space";

export class HostdPorts implements RuntimePorts {
    private readonly client: HostdClient;

    /**
     * `signal` belongs to the deployment these ports serve, and aborting it is what
     * actually stops the work rather than only recording that it stopped: the daemon
     * streams each command's output straight from the child process it spawned, and
     * kills that child when the connection it was writing to goes away.
     */
    public constructor(signal?: AbortSignal) {
        this.client = new HostdClient({ signal });
    }

    public async composeUp(spec: ComposeSpec, onOutput?: OutputSink): Promise<void> {
        const res = await this.client.deployUp(spec);
        await drain(res, onOutput);
    }

    public async composeDown(project: string, onOutput?: OutputSink): Promise<void> {
        const res = await this.client.deployDown(project);
        await drain(res, onOutput);
    }

    public async stackUp(spec: ComposeSpec, onOutput?: OutputSink): Promise<void> {
        const res = await this.client.stackUp(spec);
        await drain(res, onOutput);
    }

    public async stackDown(project: string, onOutput?: OutputSink): Promise<void> {
        const res = await this.client.stackDown(project);
        await drain(res, onOutput);
    }

    public async build(request: BuildRequest, onOutput?: OutputSink): Promise<string> {
        const tar = await bufferStream(request.contextTar);
        const res = await this.client.deployBuild(
            request.tag,
            request.dockerfile ?? "Dockerfile",
            tar,
            request.builder ?? "docker",
            request.root ?? ""
        );
        await drain(res, onOutput);
        return request.tag;
    }

    public async pull(image: string, onOutput?: OutputSink): Promise<void> {
        const res = await this.client.deployPull(image);
        await drain(res, onOutput);
    }

    /**
     * Hand back build cache and layers no tag points at, so a pull that had no
     * room can be tried once more. Volumes are never in it: the daemon's own
     * allowlist refuses a volume prune, so this cannot cross that line even by
     * asking differently.
     */
    public async reclaimSpace(): Promise<number> {
        return (await reclaimHostSpace()) ?? 0;
    }

    public async inspectImage(image: string): Promise<number[]> {
        return this.client.inspectImage(image);
    }

    public async login(registry: string, username: string, password: string): Promise<void> {
        await this.client.deployLogin(registry, username, password);
    }

    public async inspect(ref: string): Promise<unknown> {
        const response = await this.client.dockerRequest("GET", `/containers/${encodeURIComponent(ref)}/json`);
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`inspect ${ref} failed (${response.status})`);
        }
        return JSON.parse(response.body);
    }

    public async ensureMount(spec: MountTarget): Promise<boolean> {
        // The daemon confines the target under its mount root, so we pass the bare
        // connection id as the subdir. Idempotent: a live mount returns success.
        const result = await this.client.createMount({
            id: spec.id,
            kind: spec.kind,
            source: spec.source,
            target: spec.id,
            options: spec.options,
            username: spec.username,
            password: spec.password
        });
        return result.created;
    }

    public async container(ref: string, action: "restart" | "stop" | "start"): Promise<void> {
        const response = await this.client.dockerRequest("POST", `/containers/${encodeURIComponent(ref)}/${action}`);
        // 204 = done, 304 = already in that state (start/stop a no-op) - both fine.
        if (response.status !== 204 && response.status !== 304) {
            throw new Error(`${action} ${ref} failed (${response.status})`);
        }
    }

    public async logs(ref: string, onData: OutputSink, options?: LogOptions): Promise<void> {
        const res = await this.client.deployLogs({
            container: ref,
            follow: options?.follow,
            tail: options?.tail
        });
        await drain(res, onData);
    }

    public async diskUsage(ref: string, path: string): Promise<number | null> {
        try {
            // `du -sk` is in every busybox and coreutils, and reports kilobytes -
            // the one unit both agree on without a flag that one of them lacks.
            const res = await this.client.fsRead(ref, ["du", "-sk", "--", path]);
            return parseDuKilobytes(await collect(res));
        } catch {
            return null;
        }
    }

    public async wipePath(ref: string, path: string): Promise<void> {
        const res = await this.client.volumeWipe(ref, path);
        await drain(res);
    }

    public async exec(spec: ExecSpec): Promise<ExecStream> {
        const execId = await this.client.execCreate({
            container: spec.container,
            cmd: [...(spec.cmd ?? ["/bin/sh"])],
            tty: spec.tty ?? true
        });
        const socket = await this.client.execStart(execId);
        return {
            stream: socket,
            resize: async (cols, rows) => this.client.execResize(execId, cols, rows),
            close: async () => {
                socket.destroy();
            }
        };
    }

    public async runIn(container: string, argv: readonly string[]): Promise<ExecResult> {
        return this.client.execRun(container, [...argv]);
    }

    public async readFile(container: string, path: string): Promise<ReadableStream<Uint8Array>> {
        // `--` so a path that begins with a dash is a path and not a flag.
        const response = await this.client.fsRead(container, ["cat", "--", path]);
        return Readable.toWeb(response) as ReadableStream<Uint8Array>;
    }

    public async dispose(): Promise<void> {
        return undefined;
    }
}

/** How much of a streamed command's output is kept for its error message. Two
 *  thousand characters is several lines of a pull's progress and the line after
 *  them, which is where the reason lives. */
const RECENT_OUTPUT = 2000;

/** How long the line put on an error may be. The image store's own errors run to
 *  four hundred characters - two absolute paths, each with a digest in it - and
 *  cutting one of those in half loses the end, which is where "no such file or
 *  directory" is. */
const LONGEST_LINE = 500;

/**
 * The line a failed command ended on, for an error whose own message is a number.
 *
 * Progress lines are dropped - a pull writes one per layer and they are all
 * "Pull complete" by the time it goes wrong - so what is left is the sentence
 * the runtime finished with. Carriage returns count as line breaks: that is how
 * a pull redraws its progress, and treating it as one line would return the
 * whole screen of it.
 */
export function lastMeaningfulLine(output: string): string | null {
    const lines = output
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !/^\[polaris:exit:-?\d+\]$/.test(line));
    // "3db4007d5a31: Pull complete", "latest: Pulling from fjrg2007/polaris-vision".
    const said = lines.filter(
        (line) => !/^[0-9a-f]{8,}: |^[a-z0-9._-]+: (Pulling|Waiting|Already)/i.test(line)
    );
    const line = (said.length > 0 ? said : lines).pop();
    if (!line) return null;
    if (line.length <= LONGEST_LINE) return line;
    // Cut where a word ends, and say that it was cut. The store's own errors
    // name two absolute paths with a digest in each, so this is a real length
    // rather than a defensive one - and stopping mid-word reads as a bug in the
    // message rather than as a message that was too long.
    const cut = line.slice(0, LONGEST_LINE);
    const space = cut.lastIndexOf(" ");
    return `${(space > LONGEST_LINE / 2 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

/** Pipe a streamed daemon response into a sink and resolve when it ends. */
function drain(stream: Readable & { statusCode?: number }, onOutput?: OutputSink): Promise<void> {
    return new Promise((resolve, reject) => {
        // Two failure signals must both surface as a rejected promise, or a failed
        // deploy reads as a silent success:
        //   1. A non-2xx HTTP status - the daemon could not even start the command
        //      (e.g. 502 "could not start docker compose"); the body is the reason.
        //   2. A "[polaris:exit:N]" trailer the daemon appends when a streamed
        //      command (build, compose up, pull, ...) itself exits non-zero.
        const status = stream.statusCode ?? 200;
        const failedStatus = status < 200 || status >= 300;
        let tail = "";
        let body = "";
        let recent = "";
        stream.on("data", (chunk: Buffer) => {
            if (onOutput) onOutput(chunk);
            const text = chunk.toString("utf8");
            tail = (tail + text).slice(-120);
            if (failedStatus) body = (body + text).slice(-500);
            // Kept whether or not this ends badly, because by the time it does
            // the words are already gone. See below.
            recent = (recent + text).slice(-RECENT_OUTPUT);
        });
        stream.on("end", () => {
            if (failedStatus) {
                reject(new Error(body.trim() || `the daemon returned HTTP ${status}`));
                return;
            }
            const match = tail.match(/\[polaris:exit:(-?\d+)\]/);
            if (!match || match[1] === "0") {
                resolve();
                return;
            }
            // What the command said, not only that it failed. An exit code on
            // its own defeats the whole of deploy-failure.ts: the sentence that
            // says the disk filled up is in the output, the error carried a
            // number, and the operator was told "the command failed (exit 1)"
            // about a machine with no room on it.
            const said = lastMeaningfulLine(recent);
            reject(new Error(`the command failed (exit ${match[1]})${said ? `: ${said}` : ""}`));
        });
        stream.on("error", reject);
    });
}

/** Collect a streamed response into a string, ignoring the exit trailer. */
function collect(stream: Readable): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        stream.on("error", reject);
    });
}

/**
 * Read the byte total out of `du -sk` output. The first field of the last
 * non-empty line is the figure: busybox prints one line, coreutils prints one
 * per argument, and both put the total for the path last.
 */
export function parseDuKilobytes(output: string): number | null {
    const line = output
        .split("\n")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && /^\d/.test(entry))
        .pop();
    if (!line) return null;
    const kilobytes = Number.parseInt(line.split(/\s+/)[0] ?? "", 10);
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
}

/** Collect a readable stream into a single Buffer. */
function bufferStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(chunks)));
        stream.on("error", reject);
    });
}
