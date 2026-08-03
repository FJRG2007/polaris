/**
 * Build-from-source support: shallow-clone a git repo and tar its contents into a
 * build context stream. The runtime feeds that tar to the build port (the host
 * daemon's `docker build`, or `docker build` over SSH). The web container needs
 * `git` and `tar` on PATH (added to its image).
 *
 * For a source with no Dockerfile it also works out how to build and run what was
 * cloned, and writes that into the context as a nixpacks.toml. Doing it here, on
 * the clone, rather than against a forge's API is what makes it work for any git
 * host and lets it read the manifest inside a monorepo's subdirectory - and doing
 * it as a file in the context rather than as flags on the build means the host
 * daemon's command never changes, so none of this needs a new daemon on any
 * enrolled machine.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import {
    detectBuild,
    nixpacksConfig,
    type BuildContext,
    type PackageManifest,
    type RepoSnapshot
} from "@polaris/deploy";

export interface GitSource {
    repoUrl: string;
    branch?: string;
    /**
     * Optional git `http.extraHeader` value (e.g. "Authorization: Basic ...") used to
     * authenticate the clone of a private repository. Passed via `-c` so the credential
     * never appears in the clone URL or the streamed deployment log.
     */
    authHeader?: string;
}

/** What the service says about building itself, over and above what is detected.
 *  Any command set here wins - detection is a default, not a ceiling. */
export interface BuildCommands {
    /** The service's root directory, "" or absent for the repository root. */
    rootDirectory?: string;
    installCommand?: string | null;
    buildCommand?: string | null;
    startCommand?: string | null;
}

/** Whether a repo URL is a scheme we will clone (http/https/git, no ssh/file). */
export function isCloneableUrl(url: string): boolean {
    return /^(https?|git):\/\/[^\s]+$/.test(url.trim());
}

/** Parse a package.json, or undefined when it is missing or not JSON. A malformed
 *  manifest is the repository's problem to fix, not a reason to fail the clone. */
async function readManifest(directory: string): Promise<PackageManifest | undefined> {
    try {
        return JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as PackageManifest;
    } catch {
        return undefined;
    }
}

async function listDirectory(directory: string): Promise<string[]> {
    try {
        return await readdir(directory);
    } catch {
        return [];
    }
}

/**
 * Read every directory from the repository root down to the service's own, which
 * is what lets detection find a workspace root that is neither of the two - a
 * repository can hold one project at the top and the JavaScript workspace two
 * levels inside it.
 */
async function snapshot(dir: string, rootDirectory: string | undefined): Promise<RepoSnapshot> {
    const segments = (rootDirectory ?? "").split("/").filter(Boolean);
    const paths = ["", ...segments.map((_, at) => segments.slice(0, at + 1).join("/"))];
    const levels = await Promise.all(
        paths.map(async (path) => {
            const directory = path ? join(dir, path) : dir;
            const [files, manifest] = await Promise.all([listDirectory(directory), readManifest(directory)]);
            return { path, files, manifest };
        })
    );
    return { levels };
}

/**
 * Work out how to build the clone, write it into the context, and report where the
 * builder should be pointed.
 *
 * A repository that ships its own nixpacks.toml is left alone: it has said what it
 * wants more precisely than any detection can, and overwriting it would be Polaris
 * quietly winning an argument with the person who wrote it.
 */
async function configureBuild(
    dir: string,
    commands: BuildCommands,
    log: (line: string) => void
): Promise<string | undefined> {
    const rootDirectory = commands.rootDirectory || undefined;
    const detected = await snapshot(dir, rootDirectory).then(detectBuild);
    const buildRoot = detected?.buildRoot ?? rootDirectory ?? "";
    const configDir = buildRoot ? join(dir, buildRoot) : dir;

    if ((await listDirectory(configDir)).some((name) => name === "nixpacks.toml" || name === "nixpacks.json")) {
        log("Using the nixpacks configuration in the repository.\n");
        return detected?.buildRoot;
    }

    // Said before anything else: when detection recognized the shape but cannot run
    // it, this line is the only thing standing between the operator and an opaque
    // "No start command could be found" from the builder.
    if (detected) log(`Detected ${detected.note}.\n`);

    const config = nixpacksConfig({
        packages: detected?.packages,
        install: commands.installCommand || detected?.install,
        build: commands.buildCommand || detected?.build,
        start: commands.startCommand || detected?.start
    });
    if (!config) {
        if (!detected) log("No framework recognized; letting the builder work it out.\n");
        return detected?.buildRoot;
    }

    const overridden = (["installCommand", "buildCommand", "startCommand"] as const).filter((key) => commands[key]);
    if (overridden.length > 0) {
        log(`Using the ${overridden.map((key) => key.replace("Command", "")).join(", ")} command set on this service.\n`);
    }
    await writeFile(join(configDir, "nixpacks.toml"), config, "utf8");
    return detected?.buildRoot;
}

/**
 * Return a build-context factory for a git source: each call shallow-clones into a
 * fresh temp dir and streams a tar of it, cleaning the dir up once the tar is fully
 * read. Clone output is streamed to `onOutput` (the deployment log).
 *
 * `commands` is absent for a Dockerfile build, which states its own everything and
 * must not have a nixpacks configuration written into it.
 */
export function gitBuildContext(
    source: GitSource,
    onOutput: (chunk: Buffer) => void,
    commands?: BuildCommands
): () => Promise<BuildContext> {
    if (!isCloneableUrl(source.repoUrl)) {
        throw new Error("Only http(s)/git repository URLs are supported");
    }
    const log = (line: string): void => onOutput(Buffer.from(line));
    return async () => {
        const dir = await mkdtemp(join(tmpdir(), "polaris-build-"));
        // Repo-level config (`-c`) must precede the subcommand.
        const args: string[] = [];
        if (source.authHeader) args.push("-c", `http.extraHeader=${source.authHeader}`);
        args.push("clone", "--depth", "1");
        if (source.branch) args.push("--branch", source.branch);
        args.push("--", source.repoUrl, dir);
        await runCommand("git", args, onOutput);

        // Best-effort: a repository that defeats detection still deploys exactly as
        // it did before, with the builder left to its own devices.
        let root: string | undefined;
        if (commands) {
            try {
                root = await configureBuild(dir, commands, log);
            } catch (error) {
                log(`Could not inspect the source: ${error instanceof Error ? error.message : "unknown error"}\n`);
            }
        }

        // Tar the working tree (excluding the .git dir) as the build context.
        const child = spawn("tar", ["-C", dir, "--exclude=./.git", "-c", "."]);
        child.stderr.on("data", (chunk: Buffer) => onOutput(chunk));
        const cleanup = (): void => void rm(dir, { recursive: true, force: true });
        child.stdout.on("close", cleanup);
        child.stdout.on("error", cleanup);
        return { tar: child.stdout, root };
    };
}

function runCommand(command: string, args: string[], onOutput: (chunk: Buffer) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args);
        child.stdout.on("data", (chunk: Buffer) => onOutput(chunk));
        child.stderr.on("data", (chunk: Buffer) => onOutput(chunk));
        child.on("error", reject);
        child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code ?? -1}`))
        );
    });
}
