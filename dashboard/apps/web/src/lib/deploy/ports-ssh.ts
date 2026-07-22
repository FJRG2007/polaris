/**
 * RuntimePorts backed by SSH for a remote server. Running Docker/compose over an
 * authenticated, host-key-pinned SSH connection is expected on the user's own
 * box, so these methods build safe `docker ...` command lines (every interpolated
 * value is shell-quoted) and stream their output. The compose file is written
 * base64-encoded to avoid any quoting hazard.
 */

import type { Client } from "ssh2";
import { quoteArg, renderComposeYaml, type ComposeSpec, type ExecSpec, type ExecStream, type LogOptions, type MountTarget, type OutputSink, type RuntimePorts } from "@polaris/deploy";
import { execCommand, openShell, openSshClient, type SshAuth } from "@polaris/ssh";

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

    public constructor(private readonly target: SshTarget) {}

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
        const yaml = renderComposeYaml(spec, REMOTE_VOLUME_ROOT, REMOTE_MOUNT_ROOT);
        const b64 = Buffer.from(yaml, "utf8").toString("base64");
        const dir = `${REMOTE_DEPLOY_ROOT}/${spec.project}`;
        const file = `${dir}/compose.yml`;
        const command = [
            "set -e",
            `mkdir -p ${quoteArg(dir)} ${quoteArg(REMOTE_VOLUME_ROOT)}`,
            `printf %s ${quoteArg(b64)} | base64 -d > ${quoteArg(file)}`,
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
        const yaml = renderComposeYaml(spec, REMOTE_VOLUME_ROOT, REMOTE_MOUNT_ROOT);
        const b64 = Buffer.from(yaml, "utf8").toString("base64");
        const dir = `${REMOTE_DEPLOY_ROOT}/${spec.project}`;
        const file = `${dir}/compose.yml`;
        const command = [
            "set -e",
            `mkdir -p ${quoteArg(dir)} ${quoteArg(REMOTE_VOLUME_ROOT)}`,
            `printf %s ${quoteArg(b64)} | base64 -d > ${quoteArg(file)}`,
            `docker stack deploy -c ${quoteArg(file)} --detach=true --with-registry-auth --prune ${quoteArg(spec.project)}`
        ].join("; ");
        await this.run(command, onOutput);
    }

    public async stackDown(project: string, onOutput?: OutputSink): Promise<void> {
        await this.run(`docker stack rm ${quoteArg(project)}`, onOutput);
    }

    public async build(): Promise<string> {
        // Remote build from a tar context streamed over an exec channel is a
        // follow-up; the remote path currently deploys prebuilt images.
        throw new Error("remote build is not yet supported");
    }

    public async pull(image: string, onOutput?: OutputSink): Promise<void> {
        await this.run(`docker pull ${quoteArg(image)}`, onOutput);
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
                channel.on("close", () => (code === 0 ? resolve() : reject(new Error("registry login failed"))));
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
        const lines = [
            "set -e",
            `mkdir -p ${quoteArg(target)}`,
            `if mountpoint -q ${quoteArg(target)}; then echo polaris:already; exit 0; fi`
        ];
        // For CIFS credentials, write a 0600 credentials file so the password never
        // reaches the mount argv; $creds expands in the mount `-o` value below.
        let optionValue = staticOpts;
        const useCreds = spec.kind === "smb" && spec.username && spec.password;
        if (useCreds) {
            lines.push('creds=$(mktemp)', 'chmod 600 "$creds"');
            lines.push(`printf 'username=%s\\npassword=%s\\n' ${quoteArg(spec.username as string)} ${quoteArg(spec.password as string)} > "$creds"`);
            optionValue = staticOpts ? `credentials=$creds,${staticOpts}` : "credentials=$creds";
        }
        // The source is quoted; the option value is our own controlled string plus the
        // $creds shell var, so it is embedded in double quotes to let $creds expand.
        lines.push(`mount -t ${fstype} ${quoteArg(spec.source)} ${quoteArg(target)}${optionValue ? ` -o "${optionValue}"` : ""}`);
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
        await execCommand(client, parts.join(" "), { pty: true, onStdout: onData, onStderr: onData });
    }

    public async exec(spec: ExecSpec): Promise<ExecStream> {
        const client = await this.connect();
        const shellCmd = (spec.cmd ?? ["/bin/sh"]).map(quoteArg).join(" ");
        const command = `docker exec -it ${quoteArg(spec.container)} ${shellCmd}`;
        // Run the container exec inside a PTY channel so it behaves like a terminal.
        const channel = await new Promise<import("ssh2").ClientChannel>((resolve, reject) => {
            client.exec(command, { pty: { cols: spec.cols ?? 80, rows: spec.rows ?? 24 } }, (error, ch) =>
                error ? reject(error) : resolve(ch)
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
