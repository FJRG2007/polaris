/**
 * Client for the polaris-hostd daemon. The daemon listens on a Unix socket and
 * authenticates each call with a per-run bearer token it writes to a file that
 * is mounted read-only into this container. We read that token per request (it
 * rotates when the daemon restarts) and speak plain HTTP/1.1 over node:http,
 * which supports Unix sockets natively via socketPath - no extra dependency.
 *
 * Every response is treated as untrusted input: the daemon is privileged, but a
 * compromised or buggy daemon must not be able to corrupt the dashboard, so
 * shapes are validated before use and failures degrade to "daemon absent".
 */

import { readFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { loadEnv } from "@polaris/config";
import type { HostdHealth } from "@polaris/config";

export interface MountSpec {
    readonly id: string;
    readonly kind: "smb" | "nfs";
    readonly source: string;
    readonly target: string;
    readonly options?: string;
}

export interface MountResult {
    readonly id: string;
    readonly mountPath: string;
}

interface RawResponse {
    readonly status: number;
    readonly body: string;
}

export class HostdClient {
    private readonly socketPath?: string;
    private readonly tcpUrl?: string;
    private readonly tokenFile: string;

    public constructor(options?: { socketPath?: string; tcpUrl?: string; tokenFile?: string }) {
        const env = loadEnv();
        this.socketPath = options?.socketPath ?? env.POLARIS_HOSTD_SOCKET;
        this.tcpUrl = options?.tcpUrl ?? env.POLARIS_HOSTD_URL;
        this.tokenFile = options?.tokenFile ?? env.POLARIS_HOSTD_TOKEN_FILE;
    }

    /**
     * Probe the daemon's health. Returns the parsed capability report, or null if
     * the daemon is absent, unreachable, unauthorized, or replies with anything
     * unexpected. Null is the signal that keeps the dashboard in the limited
     * edition - the safe default.
     */
    public async health(): Promise<HostdHealth | null> {
        try {
            const response = await this.call("GET", "/v1/health");
            if (response.status !== 200) return null;
            const parsed = JSON.parse(response.body) as unknown;
            return isHealth(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }

    /** Request a native mount. Throws if the daemon rejects or is unreachable. */
    public async createMount(spec: MountSpec): Promise<MountResult> {
        const response = await this.call("POST", "/v1/mounts", JSON.stringify(spec));
        if (response.status !== 201) {
            throw new Error(`hostd mount failed (${response.status}): ${response.body}`);
        }
        const parsed = JSON.parse(response.body) as MountResult;
        return parsed;
    }

    /** Release a mount previously created through createMount. */
    public async deleteMount(id: string): Promise<void> {
        const response = await this.call("DELETE", `/v1/mounts/${encodeURIComponent(id)}`);
        if (response.status !== 200 && response.status !== 204) {
            throw new Error(`hostd unmount failed (${response.status}): ${response.body}`);
        }
    }

    /**
     * Trigger a host-side update + redeploy. "started" when the daemon kicked it
     * off, "unavailable" when the host has no update command configured, "disabled"
     * when auto-update is turned off; throws on a transport error.
     */
    public async update(): Promise<"started" | "unavailable" | "disabled"> {
        const response = await this.call("POST", "/v1/update");
        if (response.status === 202) return "started";
        if (response.status === 501) return "unavailable";
        if (response.status === 403) return "disabled";
        throw new Error(`hostd update failed (${response.status}): ${response.body}`);
    }

    /**
     * Forward one allowlisted Docker Engine API call through the daemon and
     * return the Docker status and raw response body. The daemon enforces the
     * allowlist and never mounts the socket into this container; the reply is
     * untrusted and returned verbatim for the caller to parse.
     */
    public async dockerRequest(method: string, path: string): Promise<RawResponse> {
        const response = await this.call("POST", "/v1/docker", JSON.stringify({ method, path }));
        if (response.status !== 200) {
            throw new Error(`hostd docker proxy failed (${response.status}): ${response.body}`);
        }
        const parsed = JSON.parse(response.body) as unknown;
        if (!isDockerEnvelope(parsed)) {
            throw new Error("hostd docker proxy returned an unexpected shape");
        }
        return { status: parsed.status, body: parsed.body };
    }

    /**
     * Deploy a validated compose project on the local host. The spec is
     * structured (never raw YAML) - the daemon validates and renders it - and the
     * response streams `docker compose up` output line by line.
     */
    public async deployUp(spec: unknown): Promise<IncomingMessage> {
        return this.callStream("POST", "/v1/deploy/up", JSON.stringify(spec));
    }

    /** Tear a project down, streaming output. */
    public async deployDown(project: string): Promise<IncomingMessage> {
        return this.callStream("POST", "/v1/deploy/down", JSON.stringify({ project }));
    }

    /** Deploy a spec onto a swarm (`docker stack deploy`), streaming output. */
    public async stackUp(spec: unknown): Promise<IncomingMessage> {
        return this.callStream("POST", "/v1/deploy/stack/up", JSON.stringify(spec));
    }

    /** Remove a swarm stack, streaming output. */
    public async stackDown(project: string): Promise<IncomingMessage> {
        return this.callStream("POST", "/v1/deploy/stack/down", JSON.stringify({ project }));
    }

    /** Pull an image, streaming progress. */
    public async deployPull(image: string): Promise<IncomingMessage> {
        return this.callStream("POST", "/v1/deploy/pull", JSON.stringify({ image }));
    }

    /** A locally present image's declared exposed TCP ports, ascending. Empty when
     *  the image declares none; throws only on a transport/daemon error. Used to
     *  default an app's container port to what the image actually listens on. */
    public async inspectImage(image: string): Promise<number[]> {
        const response = await this.call("POST", "/v1/deploy/inspect", JSON.stringify({ image }));
        if (response.status !== 200) {
            throw new Error(`hostd image inspect failed (${response.status}): ${response.body}`);
        }
        const parsed = JSON.parse(response.body) as { exposedPorts?: unknown };
        if (!Array.isArray(parsed.exposedPorts)) return [];
        return parsed.exposedPorts.filter((port): port is number => typeof port === "number");
    }

    /** Authenticate to a private registry (`docker login`). Resolves on success and
     *  throws on failure; the password rides in the JSON body, never in argv. */
    public async deployLogin(registry: string, username: string, password: string): Promise<void> {
        const res = await this.callStream(
            "POST",
            "/v1/deploy/login",
            JSON.stringify({ registry, username, password })
        );
        const status = res.statusCode ?? 0;
        await new Promise<void>((resolve) => {
            res.on("end", resolve);
            res.on("error", () => resolve());
            res.resume();
        });
        if (status < 200 || status >= 300) throw new Error("registry login failed");
    }

    /** Stream a container's logs, optionally following. */
    public async deployLogs(options: {
        container: string;
        follow?: boolean;
        tail?: number;
    }): Promise<IncomingMessage> {
        return this.callStream("POST", "/v1/deploy/logs", JSON.stringify(options));
    }

    /**
     * Build an image from a tar context, streaming build output. The tag and
     * dockerfile ride in headers because the daemon strips query strings; the
     * body is the raw tar (its length is known, so no chunked framing).
     */
    public async deployBuild(
        tag: string,
        dockerfile: string,
        contextTar: Buffer,
        builder: "docker" | "nixpacks" = "docker"
    ): Promise<IncomingMessage> {
        return this.callStream("POST", "/v1/deploy/build", contextTar, {
            "content-type": "application/x-tar",
            "x-polaris-tag": tag,
            "x-polaris-dockerfile": dockerfile,
            "x-polaris-builder": builder
        });
    }

    /** Run a read-only filesystem command in a container, streaming stdout (stderr
     *  dropped so a binary read is not corrupted). */
    public async fsRead(container: string, argv: string[]): Promise<IncomingMessage> {
        return this.callStream("POST", "/v1/deploy/fs/read", JSON.stringify({ container, argv }));
    }

    /** Write a file inside a container by streaming its content. */
    public async fsWrite(container: string, path: string, content: Buffer): Promise<IncomingMessage> {
        return this.callStream("POST", "/v1/deploy/fs/write", content, {
            "content-type": "application/octet-stream",
            "x-polaris-container": container,
            "x-polaris-path": path
        });
    }

    /** Create an interactive exec in a container; returns the exec id. */
    public async execCreate(spec: {
        container: string;
        cmd: string[];
        tty?: boolean;
    }): Promise<string> {
        const response = await this.call("POST", "/v1/deploy/exec/create", JSON.stringify(spec));
        if (response.status !== 200) {
            throw new Error(`hostd exec create failed (${response.status}): ${response.body}`);
        }
        const parsed = JSON.parse(response.body) as { execId?: unknown };
        if (typeof parsed.execId !== "string") throw new Error("hostd exec create returned no id");
        return parsed.execId;
    }

    /** Resize an exec's TTY. */
    public async execResize(execId: string, width: number, height: number): Promise<void> {
        const response = await this.call(
            "POST",
            "/v1/deploy/exec/resize",
            JSON.stringify({ execId, width, height })
        );
        if (response.status !== 200) {
            throw new Error(`hostd exec resize failed (${response.status})`);
        }
    }

    /**
     * Start an interactive exec and return a raw duplex to the container's PTY.
     * A raw socket is used (not node:http) so the client's keystrokes reach the
     * daemon as plain bytes, never chunk-framed; the daemon's short HTTP response
     * head is consumed here, so the returned stream is purely terminal I/O.
     */
    public async execStart(execId: string): Promise<Socket> {
        const token = await this.token();
        const socket = this.tcpUrl
            ? netConnect(splitTcp(this.tcpUrl))
            : netConnect({ path: this.socketPath ?? "" });
        return new Promise<Socket>((resolve, reject) => {
            const onError = (error: Error): void => reject(error);
            socket.once("error", onError);
            socket.on("connect", () => {
                const head =
                    `POST /v1/deploy/exec/start/${encodeURIComponent(execId)} HTTP/1.1\r\n` +
                    "Host: hostd\r\n" +
                    `Authorization: Bearer ${token}\r\n` +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: tcp\r\n\r\n";
                socket.write(head);
            });
            // Consume the daemon's response head; unshift the rest as raw output.
            let buffer = Buffer.alloc(0);
            const onData = (chunk: Buffer): void => {
                buffer = Buffer.concat([buffer, chunk]);
                const end = buffer.indexOf("\r\n\r\n");
                if (end === -1) {
                    if (buffer.length > 16 * 1024) {
                        socket.destroy();
                        reject(new Error("hostd exec start header too large"));
                    }
                    return;
                }
                socket.off("data", onData);
                socket.off("error", onError);
                const rest = buffer.subarray(end + 4);
                if (rest.length > 0) socket.unshift(rest);
                resolve(socket);
            };
            socket.on("data", onData);
        });
    }

    private async token(): Promise<string> {
        return (await readFile(this.tokenFile, "utf8")).trim();
    }

    /** Perform a request and resolve with the live response stream (unbuffered),
     *  for endpoints that stream output. The caller consumes/closes the stream. */
    private async callStream(
        method: string,
        path: string,
        body?: Buffer | string,
        extraHeaders?: Record<string, string>
    ): Promise<IncomingMessage> {
        const token = await this.token();
        const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...extraHeaders };
        if (body !== undefined) {
            if (!headers["content-type"]) headers["content-type"] = "application/json";
            headers["content-length"] = String(Buffer.byteLength(body));
        }
        const options: RequestOptions = this.tcpUrl
            ? { ...splitTcp(this.tcpUrl), path, method, headers }
            : { socketPath: this.socketPath, path, method, headers };
        return new Promise<IncomingMessage>((resolve, reject) => {
            const req = httpRequest(options, (res) => resolve(res));
            req.on("error", reject);
            if (body !== undefined) req.write(body);
            req.end();
        });
    }

    private async call(method: string, path: string, body?: string): Promise<RawResponse> {
        const token = await this.token();
        const headers: Record<string, string> = { authorization: `Bearer ${token}` };
        if (body !== undefined) {
            headers["content-type"] = "application/json";
            headers["content-length"] = String(Buffer.byteLength(body));
        }
        const options: RequestOptions = this.tcpUrl
            ? { ...splitTcp(this.tcpUrl), path, method, headers }
            : { socketPath: this.socketPath, path, method, headers };
        return new Promise<RawResponse>((resolve, reject) => {
            const req = httpRequest(options, (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () =>
                    resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
                );
            });
            req.on("error", reject);
            if (body !== undefined) req.write(body);
            req.end();
        });
    }
}

function splitTcp(url: string): { host: string; port: number } {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: Number(parsed.port) || 80 };
}

/** Structural check on the untrusted docker-proxy envelope `{ status, body }`. */
function isDockerEnvelope(value: unknown): value is { status: number; body: string } {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return typeof record.status === "number" && typeof record.body === "string";
}

/** Structural check on an untrusted health payload. */
function isHealth(value: unknown): value is HostdHealth {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    if (typeof record.version !== "string") return false;
    const caps = record.capabilities;
    if (typeof caps !== "object" || caps === null) return false;
    const flags = caps as Record<string, unknown>;
    return ["hostFilesystem", "nativeMounts", "docker", "kubernetes", "systemd", "autoUpdate"].every(
        (key) => typeof flags[key] === "boolean"
    );
}
