/**
 * Push from local: build a service here with this computer's Docker and deploy
 * the image, the way `polaris deploy --local` does.
 *
 * The same route and the same steps as the CLI's `deploy_local`: ask the service
 * for the repository to tag under, `docker build` with a fresh tag, `docker save`
 * gzipped to a private temporary file, send it to
 * `POST /api/v1/deploy/services/:id/image`, and follow the deployment it starts.
 * The image tag is removed afterwards - only the upload needed it, and the layers
 * stay in this machine's cache for the next build.
 *
 * One push window per service. Its output is the build's own, then the
 * deployment's build log as Polaris writes it; when the deployment finishes, a
 * notice says how it went, worded like the dashboard's own alert for it so the
 * two are shown once (see `notices`).
 */

import { z } from "zod";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { showNotice } from "./notices";
import { createGzip } from "node:zlib";
import { formatBytes } from "./zip-rules";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { openLocalWindow } from "./windows";
import { pipeline } from "node:stream/promises";
import { deployOutcome } from "./deploy-outcome";
import { apiKeyFor, dropApiKey } from "./key-flow";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { buildArgs, dockerEnv, dockerReady, run } from "./docker";
import { dialog, type BrowserWindow, type WebContents } from "electron";
import { PUSH_PLATFORMS, pushChoice, rememberPushChoice, type PushPlatform } from "./settings";
import { CHANNELS, type Outcome, type PushEvent, type PushPhase, type PushState } from "@/shared/bridge";
import {
    ApiFailure,
    call,
    callJson,
    deploymentSchema,
    imageTargetSchema,
    sendFile,
    startedSchema,
    type Caller,
    type DeploymentState
} from "./polaris-api";

/** What the dashboard asks to push. */
export const pushTargetSchema = z.object({
    serviceId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    href: z.string().max(2048).optional()
});

export type PushTarget = z.infer<typeof pushTargetSchema>;

export interface PushHost {
    /** The Polaris in use. */
    readonly server: () => string | null;
    /** Show the Polaris at a path, in the main window. */
    readonly showPolaris: (path?: string) => void;
}

/** How many times the build log's follow is reopened before giving up on it.
 *  Polaris ends one follow after 30 minutes, so this is ten hours of build. */
const MAX_FOLLOWS = 20;

function isPlatform(value: string): value is PushPlatform {
    return (PUSH_PLATFORMS as readonly string[]).includes(value);
}

class Push {
    readonly window: BrowserWindow;
    phase: PushPhase = "ready";
    folder: string;
    platform: string;
    private abort: AbortController | null = null;
    private buffer: string[] = [];
    private flush: ReturnType<typeof setTimeout> | null = null;

    constructor(
        readonly target: PushTarget,
        private readonly host: PushHost
    ) {
        const choice = pushChoice(target.serviceId);
        this.folder = choice?.folder ?? "";
        this.platform = choice?.platform ?? "";
        this.window = openLocalWindow("push", { title: `Push ${target.name} - Polaris`, width: 760, height: 620 });
        this.window.on("closed", () => {
            this.abort?.abort();
            pushes.delete(target.serviceId);
        });
    }

    state(): PushState {
        return {
            service: this.target.name,
            server: this.host.server() ?? "",
            folder: this.folder,
            platform: this.platform,
            phase: this.phase
        };
    }

    private send(event: PushEvent): void {
        if (!this.window.isDestroyed()) this.window.webContents.send(CHANNELS.pushEvent, event);
    }

    /** Lines are sent in small batches: a build prints thousands of them. */
    private line(text: string): void {
        this.buffer.push(text);
        this.flush ??= setTimeout(() => {
            this.flush = null;
            const lines = this.buffer.splice(0);
            if (lines.length > 0) this.send({ kind: "line", text: lines.join("\n") });
        }, 100);
    }

    private enter(phase: PushPhase): void {
        this.phase = phase;
        this.send({ kind: "state", state: this.state() });
    }

    private finish(ok: boolean, message: string, phase: PushPhase = ok ? "done" : "failed"): Outcome {
        this.abort = null;
        this.enter(phase);
        this.send({ kind: "result", ok, message });
        return ok ? { ok: true } : { ok: false, error: message };
    }

    async chooseFolder(): Promise<string | null> {
        const picked = await dialog.showOpenDialog(this.window, {
            title: `The folder to build ${this.target.name} from`,
            defaultPath: this.folder || undefined,
            properties: ["openDirectory"]
        });
        const folder = picked.canceled ? null : (picked.filePaths[0] ?? null);
        if (folder) {
            this.folder = folder;
            this.send({ kind: "state", state: this.state() });
        }
        return folder;
    }

    cancel(): void {
        this.abort?.abort();
    }

    async start(platform: string): Promise<Outcome> {
        if (this.abort) return { ok: false, error: "A push is already running." };
        if (!isPlatform(platform)) return { ok: false, error: "Choose a platform from the list." };
        const server = this.host.server();
        if (!server) return { ok: false, error: "Choose the Polaris to push to first." };
        if (!this.folder) return { ok: false, error: "Choose the folder to build first." };
        const abort = new AbortController();
        this.abort = abort;
        const folderStat = await stat(this.folder).catch(() => null);
        if (!folderStat?.isDirectory() || abort.signal.aborted) {
            this.abort = null;
            return abort.signal.aborted
                ? { ok: false, error: "Cancelled." }
                : { ok: false, error: "That folder is not there any more. Choose it again." };
        }

        this.platform = platform;
        rememberPushChoice(this.target.serviceId, { folder: this.folder, platform });
        let scratch: string | null = null;
        try {
            this.enter("checking");
            const docker = await dockerReady();
            if (abort.signal.aborted) return this.finish(false, "Cancelled.", "cancelled");
            if (!docker.ok) return this.finish(false, docker.error);

            const key = await apiKeyFor(server, this.window, abort.signal);
            if (abort.signal.aborted) return this.finish(false, "Cancelled.", "cancelled");
            if (!key) return this.finish(false, "Pushing needs an API key. Nothing was built.", "ready");
            const caller: Caller = { server, key };
            const { repository } = await callJson(
                caller,
                `/api/v1/deploy/services/${this.target.serviceId}/image`,
                imageTargetSchema,
                { signal: abort.signal }
            );
            const image = `${repository}:${randomBytes(6).toString("hex")}`;

            this.enter("building");
            this.line(`$ docker ${buildArgs(image, this.folder, this.platform).join(" ")}`);
            const built = await run("docker", buildArgs(image, this.folder, this.platform), {
                signal: abort.signal,
                onLine: (text) => this.line(text)
            });
            if (built.code !== 0) return this.finish(false, "The build failed. The lines above say why.");

            this.enter("saving");
            scratch = await mkdtemp(join(tmpdir(), "polaris-push-"));
            const archive = join(scratch, "image.tar.gz");
            await saveImage(image, archive, abort.signal);
            await run("docker", ["image", "rm", image]).catch(() => undefined);

            this.enter("sending");
            const meta = await commitOf(this.folder);
            const deploymentId = await this.upload(caller, archive, meta, abort.signal);

            this.enter("deploying");
            this.line(`Deployment ${deploymentId} started.`);
            const final = await this.follow(caller, deploymentId, abort.signal);
            if (!final) {
                return this.finish(true, "Still deploying after hours of following. It carries on in Polaris.", "cancelled");
            }
            const outcome = deployOutcome(this.target.name, final.status, final.error);
            showNotice({
                title: outcome.title,
                body: outcome.body,
                tag: `deploy:${deploymentId}`,
                once: true,
                onClick: () => this.host.showPolaris(this.target.href)
            });
            return this.finish(outcome.ok, outcome.ok ? outcome.body : `${outcome.title}. ${outcome.body}`);
        } catch (caught) {
            if (abort.signal.aborted) {
                return this.phase === "deploying"
                    ? this.finish(true, "Stopped following. The deployment carries on in Polaris.", "cancelled")
                    : this.finish(false, "Cancelled.", "cancelled");
            }
            if (caught instanceof ApiFailure) {
                if (caught.status === 401) dropApiKey();
                return this.finish(false, caught.message);
            }
            console.error("[push]", caught);
            return this.finish(false, "The push stopped on an unexpected error.");
        } finally {
            if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    /** Send the archive, answering the deployment it started. */
    private async upload(caller: Caller, archive: string, meta: CommitMeta | null, signal: AbortSignal): Promise<string> {
        const total = (await stat(archive)).size;
        let sent = 0;
        let reported = 0;
        const file = createReadStream(archive);
        file.on("data", (chunk) => {
            sent += chunk.length;
            const now = Date.now();
            if (now - reported > 250 || sent === total) {
                reported = now;
                this.send({ kind: "progress", sent, total });
            }
        });
        const headers: Record<string, string> = { "content-type": "application/gzip" };
        if (meta) {
            headers["x-polaris-commit"] = meta.sha;
            headers["x-polaris-message"] = encodeURIComponent(meta.message);
        }
        this.line(`Sending ${formatBytes(total)}...`);
        const answer = await sendFile(caller, `/api/v1/deploy/services/${this.target.serviceId}/image`, file, headers, signal);
        const parsed = startedSchema.safeParse(answer);
        if (!parsed.success) throw new ApiFailure(202, "Polaris took the image but did not say which deployment it started.");
        return parsed.data.deploymentId;
    }

    /**
     * Print the deployment's build log as it is written, until it finishes, and
     * answer where it ended - or null when it was still running after every
     * follow this window allows. Polaris ends one follow after half an hour; the
     * next picks up at the byte the last one reached.
     */
    private async follow(caller: Caller, deploymentId: string, signal: AbortSignal): Promise<DeploymentState | null> {
        let offset = 0;
        let pending = "";
        const decoder = new TextDecoder();
        for (let round = 0; round < MAX_FOLLOWS; round += 1) {
            const response = await call(caller, `/api/v1/deploy/deployments/${deploymentId}?follow=1&offset=${offset}`, {
                signal
            });
            const reader = response.body?.getReader();
            while (reader) {
                const { done, value } = await reader.read();
                if (done) break;
                offset += value.byteLength;
                const lines = (pending + decoder.decode(value, { stream: true })).split("\n");
                pending = lines.pop() ?? "";
                for (const text of lines) this.line(text);
            }
            const state = await callJson(caller, `/api/v1/deploy/deployments/${deploymentId}?tail=1`, deploymentSchema, {
                signal
            });
            if (state.done) {
                if (pending) this.line(pending);
                return state;
            }
        }
        if (pending) this.line(pending);
        return null;
    }
}

interface CommitMeta {
    readonly sha: string;
    readonly message: string;
}

/** The commit the folder is at, when it is a git checkout - what the CLI sends. */
async function commitOf(folder: string): Promise<CommitMeta | null> {
    try {
        const sha = await run("git", ["-C", folder, "rev-parse", "--verify", "HEAD"]);
        const message = await run("git", ["-C", folder, "log", "-1", "--pretty=%s"]);
        const head = sha.tail.at(-1)?.trim() ?? "";
        if (sha.code !== 0 || !/^[0-9a-f]{40,64}$/.test(head)) return null;
        return { sha: head, message: (message.code === 0 ? (message.tail.at(-1) ?? "") : "").slice(0, 400) };
    } catch {
        return null;
    }
}

/** `docker save <image> | gzip -1 > archive`, the archive readable by this user only. */
async function saveImage(image: string, archive: string, signal: AbortSignal): Promise<void> {
    const child = spawn("docker", ["save", image], {
        env: dockerEnv(),
        signal,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
    });
    let said = "";
    child.stderr.on("data", (chunk: Buffer) => {
        said = (said + chunk.toString("utf8")).slice(-2000);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
    });
    const [code] = await Promise.all([
        exited,
        pipeline(child.stdout, createGzip({ level: 1 }), createWriteStream(archive, { mode: 0o600 }), { signal })
    ]);
    if (code !== 0) {
        throw new Error(`docker save exited with ${code}: ${said.trim().split("\n").at(-1) ?? ""}`);
    }
}

const pushes = new Map<string, Push>();

/** Open the push window for a service, or bring its open one forward. */
export function openPush(target: PushTarget, host: PushHost): void {
    const open = pushes.get(target.serviceId);
    if (open && !open.window.isDestroyed()) {
        open.window.show();
        open.window.focus();
        return;
    }
    pushes.set(target.serviceId, new Push(target, host));
}

/** The push a request came from. */
export function pushOf(sender: WebContents): Push | null {
    for (const push of pushes.values()) if (push.window.webContents === sender) return push;
    return null;
}

/** Whether any push is building or sending, so quitting can ask first. */
export function pushRunning(): boolean {
    return [...pushes.values()].some((push) => ["checking", "building", "saving", "sending"].includes(push.phase));
}
