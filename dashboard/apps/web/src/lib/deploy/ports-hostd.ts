/**
 * RuntimePorts backed by polaris-hostd for the local host. Every method maps to a
 * validated daemon endpoint - never a generic shell - so the local host keeps its
 * least-privilege posture: the daemon renders and validates the compose spec, and
 * only ever runs Polaris-shaped containers.
 */

import type { Readable } from "node:stream";
import type { BuildRequest, ComposeSpec, ExecSpec, ExecStream, LogOptions, OutputSink, RuntimePorts } from "@polaris/deploy";
import { HostdClient } from "@polaris/hostd-client";

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
        const res = await this.client.deployBuild(request.tag, request.dockerfile ?? "Dockerfile", tar);
        await drain(res, onOutput);
        return request.tag;
    }

    public async pull(image: string, onOutput?: OutputSink): Promise<void> {
        const res = await this.client.deployPull(image);
        await drain(res, onOutput);
    }

    public async inspect(ref: string): Promise<unknown> {
        const response = await this.client.dockerRequest("GET", `/containers/${encodeURIComponent(ref)}/json`);
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`inspect ${ref} failed (${response.status})`);
        }
        return JSON.parse(response.body);
    }

    public async logs(ref: string, onData: OutputSink, options?: LogOptions): Promise<void> {
        const res = await this.client.deployLogs({
            container: ref,
            follow: options?.follow,
            tail: options?.tail
        });
        await drain(res, onData);
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
function drain(stream: Readable, onOutput?: OutputSink): Promise<void> {
    return new Promise((resolve, reject) => {
        if (onOutput) stream.on("data", (chunk: Buffer) => onOutput(chunk));
        else stream.resume();
        stream.on("end", () => resolve());
        stream.on("error", reject);
    });
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
