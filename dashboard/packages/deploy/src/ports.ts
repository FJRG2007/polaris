/**
 * RuntimePorts is the single execution seam every runtime driver is written
 * against, so a feature is implemented once and works on both backends:
 *   - HostdPorts (local): each method maps to a validated polaris-hostd endpoint,
 *     never a generic shell, so the local host stays least-privilege.
 *   - SshPorts (remote): each method runs over the shared SSH client (the user's
 *     own server, where running bash is expected).
 * The concrete implementations live in later phases; this is the contract they
 * satisfy and the driver depends on.
 */

import type { Duplex } from "node:stream";
import type { ComposeSpec } from "./compose-spec.js";
import type { MountTarget } from "./runtime/driver.js";

export type OutputSink = (chunk: Buffer) => void;

export interface BuildRequest {
    /** Image tag to produce. */
    readonly tag: string;
    /** Dockerfile path within the context (default "Dockerfile"). */
    readonly dockerfile?: string;
    /** A tar stream of the build context. */
    readonly contextTar: NodeJS.ReadableStream;
    readonly buildArgs?: Readonly<Record<string, string>>;
    /** Build strategy: "docker" uses the Dockerfile, "nixpacks" auto-detects the
     *  framework and builds without one. Defaults to "docker". */
    readonly builder?: "docker" | "nixpacks";
}

export interface ExecSpec {
    /** Container id or name to exec into. */
    readonly container: string;
    /** Command argv; defaults to an interactive login shell. */
    readonly cmd?: readonly string[];
    readonly tty?: boolean;
    readonly cols?: number;
    readonly rows?: number;
}

export interface ExecStream {
    /** Bidirectional raw byte stream (PTY when tty). */
    readonly stream: Duplex;
    resize(cols: number, rows: number): Promise<void>;
    close(): Promise<void>;
}

export interface LogOptions {
    readonly tail?: number;
    readonly follow?: boolean;
    readonly timestamps?: boolean;
}

export interface RuntimePorts {
    /** Validate/render the spec on the target and `up -d`, streaming output.
     *  Local sends the structured spec to the daemon; remote renders YAML. */
    composeUp(spec: ComposeSpec, onOutput?: OutputSink): Promise<void>;
    composeDown(project: string, onOutput?: OutputSink): Promise<void>;
    /** Deploy/remove the same spec on a swarm (`docker stack deploy`/`rm`). */
    stackUp(spec: ComposeSpec, onOutput?: OutputSink): Promise<void>;
    stackDown(project: string, onOutput?: OutputSink): Promise<void>;
    /** Build an image from a tar context; resolves the produced tag. */
    build(request: BuildRequest, onOutput?: OutputSink): Promise<string>;
    pull(image: string, onOutput?: OutputSink): Promise<void>;
    /** A locally present image's declared exposed TCP ports (ascending), so a deploy
     *  can default the container port to what the image actually listens on. Empty
     *  when the image declares none or inspection is unavailable. */
    inspectImage(image: string): Promise<number[]>;
    /** Authenticate to a private registry (`docker login`) so a following pull can
     *  access it. An empty registry targets Docker Hub. The password is sent out of
     *  band (stdin / request body), never on the command line. */
    login(registry: string, username: string, password: string): Promise<void>;
    /** Inspect a container/service (parsed JSON) - reads `.State.Health` etc. */
    inspect(ref: string): Promise<unknown>;
    /** Lifecycle action on an existing container: restart it, or stop/start it to
     *  disable/enable a deployment without removing it. */
    container(ref: string, action: "restart" | "stop" | "start"): Promise<void>;
    /** Ensure a NAS filesystem is mounted at `<mount_root>/<id>` on the target, so a
     *  bind volume under it resolves onto the NAS. Idempotent (a no-op if already
     *  mounted). Called before bringing a service with nas volumes up. */
    ensureMount(spec: MountTarget): Promise<void>;
    logs(ref: string, onData: OutputSink, options?: LogOptions): Promise<void>;
    /** Open an interactive exec/attach stream. */
    exec(spec: ExecSpec): Promise<ExecStream>;
    dispose(): Promise<void>;
}
