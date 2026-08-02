/**
 * RuntimePorts backed by polaris-hostd for the local host. Every method maps to a
 * validated daemon endpoint - never a generic shell - so the local host keeps its
 * least-privilege posture: the daemon renders and validates the compose spec, and
 * only ever runs Polaris-shaped containers.
 */

import type { Readable } from "node:stream";
import { HostdClient } from "@polaris/hostd-client";
import type { BuildRequest, ComposeSpec, ExecSpec, ExecStream, LogOptions, MountTarget, OutputSink, RuntimePorts } from "@polaris/deploy";

export class HostdPorts implements RuntimePorts {
    private readonly client = new HostdClient();

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
            request.builder ?? "docker"
        );
        await drain(res, onOutput);
        return request.tag;
    }

    public async pull(image: string, onOutput?: OutputSink): Promise<void> {
        const res = await this.client.deployPull(image);
        await drain(res, onOutput);
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

    public async dispose(): Promise<void> {
        return undefined;
    }
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
        stream.on("data", (chunk: Buffer) => {
            if (onOutput) onOutput(chunk);
            const text = chunk.toString("utf8");
            tail = (tail + text).slice(-120);
            if (failedStatus) body = (body + text).slice(-500);
        });
        stream.on("end", () => {
            if (failedStatus) {
                reject(new Error(body.trim() || `the daemon returned HTTP ${status}`));
                return;
            }
            const match = tail.match(/\[polaris:exit:(-?\d+)\]/);
            if (match && match[1] !== "0") reject(new Error(`the command failed (exit ${match[1]})`));
            else resolve();
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
