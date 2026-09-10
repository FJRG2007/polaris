/**
 * This computer's Docker, run the way `polaris deploy --local` runs it.
 *
 * Every command is spawned with an argument list, never through a shell, so a
 * folder or tag with a space or a quote in it is one argument and nothing else.
 *
 * An app opened from the macOS Dock or Finder does not get the PATH a terminal
 * has, and `/usr/local/bin` - where Docker Desktop links `docker` - is not on
 * it. The usual places are added for the child, after whatever PATH there is.
 */

import { homedir } from "node:os";
import { posix } from "node:path";
import { spawn } from "node:child_process";

/** The environment Docker is run with: this process's, with the places Docker
 *  is installed to on the end of PATH. Windows installs put Docker on the
 *  system PATH, which a Windows app does get, so it is left alone there. */
export function dockerEnv(base: NodeJS.ProcessEnv = process.env, platform: string = process.platform): NodeJS.ProcessEnv {
    if (platform === "win32") return base;
    const extra =
        platform === "darwin"
            ? ["/usr/local/bin", "/opt/homebrew/bin", posix.join(homedir(), ".docker", "bin")]
            : ["/usr/local/bin", "/usr/bin", "/snap/bin"];
    const current = (base.PATH ?? "").split(posix.delimiter).filter(Boolean);
    const path = [...current, ...extra.filter((dir) => !current.includes(dir))].join(posix.delimiter);
    return { ...base, PATH: path };
}

/** The arguments of `docker build`, as the CLI passes them. */
export function buildArgs(image: string, context: string, platform: string): string[] {
    return ["build", "-t", image, ...(platform ? ["--platform", platform] : []), context];
}

export interface Run {
    readonly code: number | null;
    /** The last lines it printed, for saying why it failed. */
    readonly tail: string[];
}

/**
 * Run a command, handing each line of its output to `onLine` as it is printed.
 * Resolves when it exits; rejects only when it could not be started at all.
 */
export function run(
    command: string,
    args: readonly string[],
    options: { readonly cwd?: string; readonly signal?: AbortSignal; readonly onLine?: (line: string) => void; } = {}
): Promise<Run> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: dockerEnv(),
            signal: options.signal,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
        });
        const tail: string[] = [];
        let pending = "";
        const take = (chunk: Buffer) => {
            const text = pending + chunk.toString("utf8");
            const lines = text.split(/\r?\n|\r/);
            pending = lines.pop() ?? "";
            for (const line of lines) emit(line);
        };
        const emit = (line: string) => {
            tail.push(line);
            if (tail.length > 20) tail.shift();
            options.onLine?.(line);
        };
        child.stdout.on("data", take);
        child.stderr.on("data", take);
        child.on("error", reject);
        child.on("close", (code) => {
            if (pending) emit(pending);
            resolve({ code, tail });
        });
    });
}

/**
 * Whether Docker is there and its engine is answering, and if not, what to do.
 */
export async function dockerReady(): Promise<{ readonly ok: true; } | { readonly ok: false; readonly error: string; }> {
    try {
        const result = await run("docker", ["version", "--format", "{{.Server.Version}}"], {
            signal: AbortSignal.timeout(20_000)
        });
        if (result.code === 0) return { ok: true };
        return { ok: false, error: "Docker is installed but its engine is not running. Start Docker, then try again." };
    } catch (caught) {
        const code = (caught as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
            return { ok: false, error: "Docker is not installed on this computer, so nothing can be built here." };
        }
        if (code === "ABORT_ERR") return { ok: false, error: "Docker did not answer in time. Check that it is running." };
        return { ok: false, error: "Docker could not be started on this computer." };
    }
}
