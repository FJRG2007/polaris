/**
 * RuntimePorts backed by SSH for a remote server. Running Docker/compose over an
 * authenticated, host-key-pinned SSH connection is expected on the user's own
 * box, so these methods build safe `docker ...` command lines (every interpolated
 * value is shell-quoted) and stream their output. The compose file is written
 * base64-encoded to avoid any quoting hazard.
 */

import type { Client } from "ssh2";
import { PassThrough } from "node:stream";
import { parseDuKilobytes } from "./ports-hostd";
import { execCommand, openShell, openSshClient, type SshAuth } from "@polaris/ssh";
import { DF_ROOT, PRUNE_EVERY_ENGINE, freeBytesFromDf } from "@/lib/deploy/server-space";
import {
    ensurePrivateNetworksScript,
    forCompose,
    isReleaseImage,
    parseReclaimedBytes,
    quoteArg,
    renderComposeYaml,
    type BuildRequest,
    type ComposeSpec,
    type ExecResult,
    type ExecSpec,
    type ExecStream,
    type LogOptions,
    type MountTarget,
    type OutputSink,
    type RuntimePorts
} from "@polaris/deploy";

/** Where compose files and volume data live on a managed remote server. */
const REMOTE_DEPLOY_ROOT = "/var/lib/polaris/deploy";
const REMOTE_VOLUME_ROOT = "/var/lib/polaris/volumes";
/** Where storage connections (NAS/UNAS) are mounted on the host; nas-backed binds
 *  resolve under it. Matches the local daemon's mount root. */
const REMOTE_MOUNT_ROOT = "/mnt/polaris";

export interface SshTarget {
    readonly address: string;
    readonly port: number;
    readonly username: string;
    readonly auth: SshAuth;
    readonly hostKey?: string;
}

export class SshPorts implements RuntimePorts {
    private client?: Client;

    /**
     * `signal` belongs to the deployment these ports serve. Ending the connection is
     * how a remote command is stopped: the server kills what it was running when the
     * channel it was writing to closes, the same way an interrupted ssh session does.
     */
    public constructor(
        private readonly target: SshTarget,
        signal?: AbortSignal
    ) {
        signal?.addEventListener("abort", () => void this.dispose().catch(() => undefined), {
            once: true
        });
    }

    private async connect(): Promise<Client> {
        if (this.client) return this.client;
        this.client = await openSshClient({
            host: this.target.address,
            port: this.target.port,
            username: this.target.username,
            auth: this.target.auth,
            pinnedHostKey: this.target.hostKey
        });
        return this.client;
    }

    public async composeUp(spec: ComposeSpec, onOutput?: OutputSink): Promise<void> {
        // Escaped for compose's own interpolation - see `forCompose`.
        const yaml = renderComposeYaml(forCompose(spec), REMOTE_VOLUME_ROOT, REMOTE_MOUNT_ROOT);
        const b64 = Buffer.from(yaml, "utf8").toString("base64");
        const dir = `${REMOTE_DEPLOY_ROOT}/${spec.project}`;
        const file = `${dir}/compose.yml`;
        const command = [
            "set -e",
            `mkdir -p ${quoteArg(dir)} ${quoteArg(REMOTE_VOLUME_ROOT)}`,
            `printf %s ${quoteArg(b64)} | base64 -d > ${quoteArg(file)}`,
            // Compose only joins a network that already exists; a private one is
            // made here the first time a service names it (the daemon does the same
            // on Polaris's own machine).
            ...ensurePrivateNetworksScript(spec.networks, false),
            `docker compose -p ${quoteArg(spec.project)} -f ${quoteArg(file)} up -d --remove-orphans`
        ].join("; ");
        await this.run(command, onOutput);
    }

    public async composeDown(project: string, onOutput?: OutputSink): Promise<void> {
        const file = `${REMOTE_DEPLOY_ROOT}/${project}/compose.yml`;
        await this.run(
            `docker compose -p ${quoteArg(project)} -f ${quoteArg(file)} down`,
            onOutput
        );
    }

    public async stackUp(spec: ComposeSpec, onOutput?: OutputSink): Promise<void> {
        const yaml = renderComposeYaml(forCompose(spec), REMOTE_VOLUME_ROOT, REMOTE_MOUNT_ROOT);
        const b64 = Buffer.from(yaml, "utf8").toString("base64");
        const dir = `${REMOTE_DEPLOY_ROOT}/${spec.project}`;
        const file = `${dir}/compose.yml`;
        const command = [
            "set -e",
            `mkdir -p ${quoteArg(dir)} ${quoteArg(REMOTE_VOLUME_ROOT)}`,
            `printf %s ${quoteArg(b64)} | base64 -d > ${quoteArg(file)}`,
            ...ensurePrivateNetworksScript(spec.networks, true),
            `docker stack deploy -c ${quoteArg(file)} --detach=true --with-registry-auth --prune ${quoteArg(spec.project)}`
        ].join("; ");
        await this.run(command, onOutput);
    }

    public async stackDown(project: string, onOutput?: OutputSink): Promise<void> {
        await this.run(`docker stack rm ${quoteArg(project)}`, onOutput);
    }

    /**
     * Build an image on the server from a tar context streamed over the channel.
     *
     * The context rides the encrypted channel's stdin, the same way a registry
     * password does, so nothing is staged on the server for Polaris to clean up:
     * `docker build -` reads it straight in. Nixpacks needs a directory, so for it
     * the tar is unpacked into a private temporary one that goes whatever the
     * build does - and a server without nixpacks says so rather than failing on a
     * command it does not have.
     *
     * The Dockerfile path and the root directory are confined the way the local
     * daemon confines them: a value that climbs out of the context would let a
     * build read whatever else is on that disk.
     */
    public async build(request: BuildRequest, onOutput?: OutputSink): Promise<string> {
        const dockerfile = request.dockerfile ?? "Dockerfile";
        const root = request.root ?? "";
        if (!confinedPath(dockerfile) || (root !== "" && !confinedPath(root))) {
            throw new Error("the build path leaves its context");
        }
        const script =
            request.builder === "nixpacks"
                ? [
                      "set -e",
                      'command -v nixpacks >/dev/null 2>&1 || { echo "nixpacks is not installed on this server" >&2; exit 127; }',
                      "d=$(mktemp -d)",
                      "trap 'rm -rf \"$d\"' EXIT",
                      'tar -x -C "$d"',
                      `nixpacks build "$d"/${quoteArg(root || ".")} --name ${quoteArg(request.tag)}`
                  ].join("\n")
                : `docker build -t ${quoteArg(request.tag)} -f ${quoteArg(dockerfile)} -`;
        const client = await this.connect();
        await new Promise<void>((resolve, reject) => {
            client.exec(script, (error, channel) => {
                if (error || !channel) {
                    reject(error ?? new Error("could not open the exec channel"));
                    return;
                }
                let code: number | null = null;
                channel.on("data", (chunk: Buffer) => onOutput?.(chunk));
                channel.stderr.on("data", (chunk: Buffer) => onOutput?.(chunk));
                channel.on("exit", (exitCode: number) => {
                    code = exitCode;
                });
                channel.on("close", () =>
                    code === 0
                        ? resolve()
                        : reject(new Error(`the build exited with code ${code ?? -1}`))
                );
                channel.on("error", reject);
                const tar = request.contextTar;
                tar.on("error", (tarError: Error) => {
                    channel.close();
                    reject(tarError);
                });
                tar.pipe(channel);
            });
        });
        return request.tag;
    }

    /** Take a pinned release image off the server once it has fallen out of the
     *  kept window. Nothing else is ever handed here: the name is checked against
     *  the release naming before it reaches a shell. Not forced, so an image a
     *  container still runs is refused by the engine rather than pulled out from
     *  under it. */
    public async removeImage(image: string): Promise<void> {
        if (!isReleaseImage(image)) throw new Error("only a kept release image can be removed");
        await this.run(`docker image rm ${quoteArg(image)}`);
    }

    /** `docker image inspect` exits non-zero for an image the machine lacks. */
    public async hasImage(image: string): Promise<boolean> {
        return this.run(`docker image inspect --format '{{.Id}}' ${quoteArg(image)}`).then(
            () => true,
            () => false
        );
    }

    public async pull(image: string, onOutput?: OutputSink): Promise<void> {
        await this.run(`docker pull ${quoteArg(image)}`, onOutput);
    }

    /**
     * `docker save | gzip` on the server, as a stream. A save that fails writes
     * to stderr and leaves gzip with nothing to compress; either ends the stream
     * with an error rather than a valid, empty archive.
     */
    public async exportImage(image: string): Promise<NodeJS.ReadableStream> {
        if (!isReleaseImage(image))
            throw new Error("only a kept release image can be sent to another machine");
        const client = await this.connect();
        return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
            client.exec(`docker save ${quoteArg(image)} | gzip -1`, (error, channel) => {
                if (error || !channel) {
                    reject(error ?? new Error("could not open the exec channel"));
                    return;
                }
                const out = new PassThrough();
                let said = "";
                channel.stderr.on("data", (chunk: Buffer) => {
                    if (said.length < 2000) said += chunk.toString("utf8");
                });
                channel.on("close", (code: number) => {
                    if (code === 0 && !said.trim()) out.end();
                    else
                        out.destroy(
                            new Error(
                                `reading ${image} exited with code ${code}${said ? `: ${said.trim()}` : ""}`
                            )
                        );
                });
                channel.on("error", (channelError: Error) => out.destroy(channelError));
                channel.pipe(out, { end: false });
                resolve(out);
            });
        });
    }

    /** `docker load` on the server, fed the archive on stdin. */
    public async importImage(
        archive: NodeJS.ReadableStream,
        _size: number,
        onOutput?: OutputSink
    ): Promise<void> {
        const client = await this.connect();
        await new Promise<void>((resolve, reject) => {
            client.exec("docker load", (error, channel) => {
                if (error || !channel) {
                    reject(error ?? new Error("could not open the exec channel"));
                    return;
                }
                let code: number | null = null;
                channel.on("data", (chunk: Buffer) => onOutput?.(chunk));
                channel.stderr.on("data", (chunk: Buffer) => onOutput?.(chunk));
                channel.on("exit", (exitCode: number) => {
                    code = exitCode;
                });
                channel.on("close", () =>
                    code === 0
                        ? resolve()
                        : reject(new Error(`loading the image exited with code ${code ?? -1}`))
                );
                channel.on("error", reject);
                archive.on("error", (archiveError: Error) => {
                    channel.close();
                    reject(archiveError);
                });
                archive.pipe(channel);
            });
        });
    }

    public async inspectImage(image: string): Promise<number[]> {
        let out = "";
        try {
            await this.run(
                `docker image inspect ${quoteArg(image)} --format ${quoteArg("{{json .Config.ExposedPorts}}")}`,
                (chunk) => {
                    out += chunk.toString("utf8");
                }
            );
        } catch {
            // The image may not be present / inspectable; the caller falls back to a
            // default port, so a failure here is not fatal.
            return [];
        }
        return parseExposedTcpPorts(out);
    }

    /**
     * Hand back the room nothing is using on this machine.
     *
     * The reason this exists at all: without it, a deploy to an enrolled server
     * that runs out of disk is simply refused. The runtime asks the ports to free
     * space before giving up, the local daemon answers, and a server had no such
     * method - so `!ctx.ports.reclaimSpace` was true and the failure was rethrown
     * with a message telling the operator to go and tidy the machine themselves.
     * Every time. On the one kind of machine Polaris never prunes on a timer.
     *
     * Build cache and untagged images only, exactly like the local sweep, and for
     * the same reason: both come back on the next build or pull at the cost of
     * time, and everything else on that disk is somebody's data. `-a` on the image
     * prune is deliberate - it takes images no container is on, which is what a
     * machine full of superseded `:latest` layers is holding.
     *
     * Both prunes run even if the first frees nothing: they hold different things.
     * A prune that fails contributes nothing rather than failing the reclaim -
     * this is already the recovery path, and a machine that cannot prune is a
     * machine the caller should hear "nothing freed" about, not an exception.
     */
    /**
     * How full the machine is, for the caller deciding whether to make room
     * before asking it for several gigabytes.
     *
     * At the filesystem root rather than at the container store's own path: which
     * path that is depends on the engine, and on almost every machine they are
     * the same filesystem anyway. `-P` for the POSIX format, without which a long
     * device name wraps onto its own line and the columns move.
     */
    public async diskFullness(): Promise<number | null> {
        let said = "";
        await this.run(DF_ROOT, (chunk) => {
            said += chunk.toString("utf8");
        }).catch(() => undefined);
        const line = said
            .split("\n")
            .map((row) => row.trim())
            .filter((row) => row !== "")
            .at(-1);
        if (!line) return null;
        // device, 1024-blocks, used, available, capacity%, mount
        const columns = line.split(/\s+/);
        const used = Number(columns[2]);
        const available = Number(columns[3]);
        if (!Number.isFinite(used) || !Number.isFinite(available)) return null;
        const total = used + available;
        return total > 0 ? used / total : null;
    }

    public async reclaimSpace(): Promise<number> {
        // Measured on the disk rather than read off what a prune printed, and
        // asked of every engine rather than of Docker alone. Both for the same
        // reason: a machine Polaris deploys to is not necessarily a Docker
        // machine, and the one that refused a deploy for want of room was being
        // swept with a command it does not have and asked for a total it never
        // prints. The commands and the reading are shared with the housekeeping
        // sweep - see `deploy/server-space` - so what a failed deploy frees and
        // what the timer frees can never drift apart.
        const before = await this.freeBytes();
        let said = "";
        const keep = (chunk: Buffer): void => {
            said += chunk.toString("utf8");
        };
        await this.run(PRUNE_EVERY_ENGINE, keep).catch(() => undefined);
        const after = await this.freeBytes();
        if (before !== null && after !== null && after > before) return after - before;
        return parseReclaimedBytes(said);
    }

    /** How much room the machine has, or null where it could not be asked. */
    private async freeBytes(): Promise<number | null> {
        let said = "";
        await this.run(DF_ROOT, (chunk) => {
            said += chunk.toString("utf8");
        }).catch(() => undefined);
        return said ? freeBytesFromDf(said) : null;
    }

    public async login(registry: string, username: string, password: string): Promise<void> {
        const client = await this.connect();
        const parts = ["docker", "login"];
        if (registry) parts.push(quoteArg(registry));
        parts.push("-u", quoteArg(username), "--password-stdin");
        const command = parts.join(" ");
        // The password rides the encrypted channel's stdin, never the command line.
        await new Promise<void>((resolve, reject) => {
            client.exec(command, (error, channel) => {
                if (error) return reject(error);
                let code: number | null = null;
                channel.on("data", () => undefined);
                channel.stderr.on("data", () => undefined);
                channel.on("exit", (exitCode: number) => {
                    code = exitCode;
                });
                channel.on("close", () =>
                    code === 0 ? resolve() : reject(new Error("registry login failed"))
                );
                channel.on("error", reject);
                channel.write(password);
                channel.end();
            });
        });
    }

    public async inspect(ref: string): Promise<unknown> {
        let out = "";
        await this.run(`docker inspect ${quoteArg(ref)}`, (chunk) => {
            out += chunk.toString("utf8");
        });
        const parsed = JSON.parse(out) as unknown;
        return Array.isArray(parsed) ? parsed[0] : parsed;
    }

    public async container(ref: string, action: "restart" | "stop" | "start"): Promise<void> {
        await this.run(`docker ${action} ${quoteArg(ref)}`);
    }

    public async ensureMount(spec: MountTarget): Promise<boolean> {
        const target = `${REMOTE_MOUNT_ROOT}/${spec.id}`;
        const fstype = spec.kind === "smb" ? "cifs" : "nfs";
        const staticOpts = spec.options ?? "";
        // The script prints a sentinel so we can tell a fresh mount from a live one:
        // `polaris:already` when the target was mounted, `polaris:created` otherwise.
        //
        // A mount point whose server has gone away stays in the mount table but
        // cannot be read or even stat'ed, so it is recognised from the table and
        // detached - otherwise `mkdir -p` fails on it and every later deploy of
        // the service dies on a path nobody can touch.
        const lines = [
            "set -e",
            `t=${quoteArg(target)}`,
            "if awk -v t=\"$t\" '$5 == t { found = 1 } END { exit !found }' /proc/self/mountinfo 2>/dev/null; then",
            '    if ls "$t" >/dev/null 2>&1; then echo polaris:already; exit 0; fi',
            '    umount -f "$t" 2>/dev/null || umount -l "$t"',
            "fi",
            'mkdir -p "$t"'
        ];
        // For CIFS credentials, write a 0600 credentials file so the password never
        // reaches the mount argv; $creds expands in the mount `-o` value below.
        let optionValue = staticOpts;
        const useCreds = spec.kind === "smb" && spec.username && spec.password;
        if (useCreds) {
            lines.push("creds=$(mktemp)", 'chmod 600 "$creds"');
            lines.push(
                `printf 'username=%s\\npassword=%s\\n' ${quoteArg(spec.username as string)} ${quoteArg(spec.password as string)} > "$creds"`
            );
            optionValue = staticOpts ? `credentials=$creds,${staticOpts}` : "credentials=$creds";
        }
        // The source is quoted; the option value is our own controlled string plus the
        // $creds shell var, so it is embedded in double quotes to let $creds expand.
        lines.push(
            `mount -t ${fstype} ${quoteArg(spec.source)} ${quoteArg(target)}${optionValue ? ` -o "${optionValue}"` : ""}`
        );
        if (useCreds) lines.push('rm -f "$creds"');
        lines.push("echo polaris:created");
        let out = "";
        await this.run(lines.join("\n"), (chunk) => {
            out += chunk.toString("utf8");
        });
        return out.includes("polaris:created");
    }

    public async logs(ref: string, onData: OutputSink, options?: LogOptions): Promise<void> {
        const parts = ["docker", "logs", "--timestamps"];
        if (options?.follow) parts.push("--follow");
        if (options?.tail !== undefined) parts.push("--tail", String(options.tail));
        parts.push(quoteArg(ref));
        const client = await this.connect();
        // A PTY so the remote `logs -f` dies when the client disconnects.
        await execCommand(client, parts.join(" "), {
            pty: true,
            onStdout: onData,
            onStderr: onData
        });
    }

    /** `docker ps` by the compose and swarm labels, names only. The project name
     *  is quoted like every other value that reaches the remote shell. */
    public async listContainers(project: string): Promise<string[]> {
        const names = new Set<string>();
        for (const label of [
            `com.docker.compose.project=${project}`,
            `com.docker.stack.namespace=${project}`
        ]) {
            let out = "";
            await this.run(
                `docker ps --filter ${quoteArg(`label=${label}`)} --format ${quoteArg("{{.Names}}")}`,
                (chunk) => {
                    out += chunk.toString("utf8");
                }
            ).catch(() => undefined);
            for (const name of out.split("\n").map((line) => line.trim()))
                if (name) names.add(name);
        }
        return [...names].sort();
    }

    public async diskUsage(ref: string, path: string): Promise<number | null> {
        let out = "";
        try {
            await this.run(`docker exec ${quoteArg(ref)} du -sk -- ${quoteArg(path)}`, (chunk) => {
                out += chunk.toString("utf8");
            });
        } catch {
            // A stopped container, or an image without `du`. Not measurable is not
            // an error: the chart says so rather than the sampler throwing.
            return null;
        }
        return parseDuKilobytes(out);
    }

    public async wipePath(ref: string, path: string): Promise<void> {
        // The path is a positional argument, never interpolated into the inner
        // command, so the same guarantee holds here as on the local daemon.
        const script = 'rm -rf -- "$1"/* "$1"/.[!.]* "$1"/..?* 2>/dev/null; exit 0';
        await this.run(
            `docker exec ${quoteArg(ref)} sh -c ${quoteArg(script)} polaris ${quoteArg(path)}`
        );
    }

    public async exec(spec: ExecSpec): Promise<ExecStream> {
        const client = await this.connect();
        const shellCmd = (spec.cmd ?? ["/bin/sh"]).map(quoteArg).join(" ");
        const command = `docker exec -it ${quoteArg(spec.container)} ${shellCmd}`;
        // Run the container exec inside a PTY channel so it behaves like a terminal.
        const channel = await new Promise<import("ssh2").ClientChannel>((resolve, reject) => {
            client.exec(
                command,
                { pty: { cols: spec.cols ?? 80, rows: spec.rows ?? 24 } },
                (error, ch) => (error ? reject(error) : resolve(ch))
            );
        });
        return {
            stream: channel,
            resize: async (cols, rows) => {
                channel.setWindow(rows, cols, 0, 0);
            },
            close: async () => {
                channel.end();
            }
        };
    }

    public async dispose(): Promise<void> {
        this.client?.end();
        this.client = undefined;
    }

    public async runIn(container: string, argv: readonly string[]): Promise<ExecResult> {
        const command = ["docker", "exec", quoteArg(container), ...argv.map(quoteArg)].join(" ");
        const client = await this.connect();
        let output = "";
        const collect = (chunk: Buffer): void => {
            output += chunk.toString("utf8");
        };
        const result = await execCommand(client, command, { onStdout: collect, onStderr: collect });
        return { code: result.code, output };
    }

    /**
     * Stream a file out of a container on the remote host.
     *
     * The bytes ride the SSH channel untouched: no collecting into a string, no
     * UTF-8 decoding, so a database dump or a world archive arrives as what it
     * is. A non-zero exit closes the stream with an error rather than leaving a
     * truncated file that looks like a complete backup.
     */
    public async readFile(container: string, path: string): Promise<ReadableStream<Uint8Array>> {
        const command = `docker exec ${quoteArg(container)} cat -- ${quoteArg(path)}`;
        const client = await this.connect();
        return new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
            client.exec(command, (error, channel) => {
                if (error || !channel) {
                    reject(error ?? new Error("could not open the exec channel"));
                    return;
                }
                let stderr = "";
                channel.stderr.on("data", (chunk: Buffer) => {
                    // Bounded: this is a reason to show, not an output to keep.
                    if (stderr.length < 2000) stderr += chunk.toString("utf8");
                });
                const web = new ReadableStream<Uint8Array>({
                    start(controller) {
                        channel.on("data", (chunk: Buffer) =>
                            controller.enqueue(new Uint8Array(chunk))
                        );
                        channel.on("close", (code: number) => {
                            if (code === 0) {
                                controller.close();
                                return;
                            }
                            controller.error(
                                new Error(
                                    `reading ${path} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
                                )
                            );
                        });
                        channel.on("error", (channelError: Error) =>
                            controller.error(channelError)
                        );
                    },
                    cancel() {
                        channel.close();
                    }
                });
                resolve(web);
            });
        });
    }

    /**
     * Stream bytes into a file inside a container on the server.
     *
     * `docker exec -i` with the channel's stdin as the file's contents: the path
     * is a positional argument to the inner shell, never interpolated into it.
     */
    public async writeFile(
        container: string,
        path: string,
        body: NodeJS.ReadableStream,
        _size: number
    ): Promise<void> {
        const command = `docker exec -i ${quoteArg(container)} sh -c ${quoteArg('cat > "$1"')} polaris ${quoteArg(path)}`;
        const client = await this.connect();
        await new Promise<void>((resolve, reject) => {
            client.exec(command, (error, channel) => {
                if (error || !channel) {
                    reject(error ?? new Error("could not open the exec channel"));
                    return;
                }
                let code: number | null = null;
                let said = "";
                channel.on("data", () => undefined);
                channel.stderr.on("data", (chunk: Buffer) => {
                    if (said.length < 2000) said += chunk.toString("utf8");
                });
                channel.on("exit", (exitCode: number) => {
                    code = exitCode;
                });
                channel.on("close", () =>
                    code === 0
                        ? resolve()
                        : reject(
                              new Error(
                                  `writing ${path} exited with code ${code ?? -1}${said ? `: ${said.trim()}` : ""}`
                              )
                          )
                );
                channel.on("error", reject);
                body.on("error", (bodyError: Error) => {
                    channel.close();
                    reject(bodyError);
                });
                body.pipe(channel);
            });
        });
    }

    private async run(command: string, onOutput?: OutputSink): Promise<void> {
        const client = await this.connect();
        const result = await execCommand(client, command, {
            onStdout: onOutput,
            onStderr: onOutput
        });
        if (result.code !== 0) {
            throw new Error(`remote command exited with code ${result.code}`);
        }
    }
}

/** A path that stays inside the build context: relative, no parent steps, no
 *  control characters. The same rule the local daemon applies to both values. */
function confinedPath(path: string): boolean {
    return (
        path.length > 0 &&
        !path.startsWith("/") &&
        !path.startsWith("\\") &&
        !path.split(/[\\/]/).includes("..") &&
        !/[\u0000-\u001f\u007f]/.test(path)
    );
}

/** Parse docker's `ExposedPorts` map ({"5601/tcp":{},"53/udp":{}}) into the sorted
 *  set of TCP port numbers; udp and malformed input yield an empty list. */
function parseExposedTcpPorts(raw: string): number[] {
    let value: unknown;
    try {
        value = JSON.parse(raw.trim() || "null");
    } catch {
        return [];
    }
    if (typeof value !== "object" || value === null) return [];
    const ports = Object.keys(value)
        .map((key) => (key.endsWith("/tcp") ? Number(key.slice(0, -"/tcp".length)) : NaN))
        .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
    return [...new Set(ports)].sort((a, b) => a - b);
}

/** Open a PTY shell to the server itself (not a container), for the terminal. */
export async function sshServerShell(
    target: SshTarget,
    cols: number,
    rows: number
): Promise<ExecStream> {
    const client = await openSshClient({
        host: target.address,
        port: target.port,
        username: target.username,
        auth: target.auth,
        pinnedHostKey: target.hostKey
    });
    const channel = await openShell(client, { cols, rows });
    return {
        stream: channel,
        resize: async (c, r) => {
            channel.setWindow(r, c, 0, 0);
        },
        close: async () => {
            channel.end();
            client.end();
        }
    };
}
