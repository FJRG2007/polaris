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
    generateDockerfile,
    GENERATED_DOCKERFILE,
    INSTALL_ENV,
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
    /** Whose account that header speaks for, for the log to name. Never the
     *  credential itself - only who it belongs to. */
    authAs?: string;
}

/** What the service says about building itself, over and above what is detected.
 *  Any command set here wins - detection is a default, not a ceiling. */
export interface BuildCommands {
    /** The service's root directory, "" or absent for the repository root. */
    rootDirectory?: string;
    installCommand?: string | null;
    buildCommand?: string | null;
    startCommand?: string | null;
    /** The port the plan publishes, so a generated image listens where the
     *  deployment expects it rather than on the framework's own default. */
    port?: number;
}

/**
 * How much of a failed clone is kept to explain it. Git says why in its last few
 * lines; a repository whose clone is chatty must not build a megabyte of string
 * that nothing will read.
 */
const TRANSCRIPT_LIMIT = 4000;

/**
 * What git says when it was refused for want of an account, in each of the ways
 * it says it.
 *
 * Recognized rather than passed on as it stands, because as it stands it is a
 * note about a terminal: git wanted a username, there was no terminal to ask at,
 * and it reported that as the errno of a missing device. True about the process
 * and useless to the person who pressed Deploy - and on a screen that never
 * mentions a command line, useless is the whole of the problem.
 */
const NEEDS_AN_ACCOUNT =
    /could not read (?:Username|Password)|Authentication failed|terminal prompts disabled|Invalid username or password|Repository not found|returned error: 40[13]/i;

/**
 * The clone is never allowed to ask.
 *
 * Nothing is watching a deploy run, so a prompt is either an instant failure with
 * a confusing reason or - where a credential helper is installed on the machine -
 * a build that hangs until the deadline stops it. Off, so it is always the first.
 */
const NO_PROMPTS = { GIT_TERMINAL_PROMPT: "0" } as const;

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
): Promise<{ root?: string; dockerfile?: string }> {
    const rootDirectory = commands.rootDirectory || undefined;
    const detected = await snapshot(dir, rootDirectory).then(detectBuild);
    const buildRoot = detected?.buildRoot ?? rootDirectory ?? "";
    const configDir = buildRoot ? join(dir, buildRoot) : dir;

    if (detected) log(`Detected ${detected.note}.\n`);

    // Recognized well enough to say exactly how to build it: write a Dockerfile
    // and use the ordinary Docker path. This is what puts the runtime version
    // under Polaris's control - an image tag is the current release of that major
    // whenever it is pulled, where the auto-detecting builder can only offer
    // whatever its own version was pinned to years ago.
    if (detected?.image) {
        const overridden = {
            install: commands.installCommand || detected.image.install,
            build: commands.buildCommand || detected.image.build,
            start: commands.startCommand || detected.image.start
        };
        await writeFile(
            join(dir, GENERATED_DOCKERFILE),
            generateDockerfile({ ...detected.image, ...overridden, port: commands.port ?? 3000 }),
            "utf8"
        );
        log(`Building on ${detected.image.buildImage}.\n`);
        return { dockerfile: GENERATED_DOCKERFILE };
    }

    const entries = await listDirectory(configDir);
    if (entries.some((name) => name === "nixpacks.toml" || name === "nixpacks.json")) {
        log("Using the nixpacks configuration in the repository.\n");
        return { root: detected?.buildRoot };
    }

    // Not recognized, or recognized as something no image can be written for. The
    // auto-detecting builder is left in charge exactly as before; anything the
    // service set by hand is still passed to it.
    //
    // The install environment goes in only where it applies. It is the builder that
    // installs here, so it is the builder that would otherwise refuse a lockfile
    // holding anything published today - but a stack with no pnpm lockfile has
    // nothing to gain from it, and for those the file written stays byte-for-byte
    // what it was.
    const config = nixpacksConfig({
        variables: entries.includes("pnpm-lock.yaml") ? INSTALL_ENV : undefined,
        install: commands.installCommand,
        build: commands.buildCommand,
        start: commands.startCommand
    });

    const overridden = (["installCommand", "buildCommand", "startCommand"] as const).filter((key) => commands[key]);
    if (overridden.length > 0) log(`Using the ${overridden.map((key) => key.replace("Command", "")).join(", ")} command set on this service.\n`);
    else if (!detected) log("No framework recognized; letting the builder work it out.\n");

    if (config) await writeFile(join(configDir, "nixpacks.toml"), config, "utf8");
    return { root: detected?.buildRoot };
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
        // Said before the attempt rather than after it. A clone that goes out as
        // nobody is the one failure here nobody can read backwards from git's
        // own words, and it is the common one: a private repository with no
        // account connected to it looks exactly like a repository that is not
        // there.
        log(
            source.authAs
                ? `Cloning as ${source.authAs}.\n`
                : "Cloning with no connected account - a private repository will refuse this.\n"
        );
        let said = "";
        const watched = (chunk: Buffer): void => {
            if (said.length < TRANSCRIPT_LIMIT) said += chunk.toString("utf8");
            onOutput(chunk);
        };
        try {
            await runCommand("git", args, watched, NO_PROMPTS);
        } catch (error) {
            await rm(dir, { recursive: true, force: true });
            throw new Error(cloneRefusal(said, source) ?? (error instanceof Error ? error.message : "the clone failed"));
        }

        // Best-effort: a repository that defeats detection still deploys exactly as
        // it did before, with the builder left to its own devices.
        let configured: { root?: string; dockerfile?: string } = {};
        if (commands) {
            try {
                configured = await configureBuild(dir, commands, log);
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
        return { tar: child.stdout, ...configured };
    };
}

/**
 * Why a clone was refused, in terms of what the reader can do about it, or null
 * when it failed for some other reason and git's own words are the best there is.
 *
 * The two cases are worth telling apart. Nothing connected means the deploy
 * reached a private repository as nobody, and connecting the account fixes it. A
 * credential that was sent and refused means the account is linked and cannot see
 * this repository, which is a different thing to go and do.
 */
export function cloneRefusal(said: string, source: GitSource): string | null {
    if (!NEEDS_AN_ACCOUNT.test(said)) return null;
    const repo = source.repoUrl.replace(/^[a-z]+:\/\//i, "").replace(/\.git$/i, "");
    return source.authHeader
        ? `${repo} refused the connected account. It may no longer have access to the repository, or the account may need linking again under Connected accounts.`
        : `${repo} needs an account: it is private, or it is not there. Connect the account that can see it under Connected accounts, then deploy again.`;
}

function runCommand(
    command: string,
    args: string[],
    onOutput: (chunk: Buffer) => void,
    env?: Record<string, string>
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, env ? { env: { ...process.env, ...env } } : undefined);
        child.stdout.on("data", (chunk: Buffer) => onOutput(chunk));
        child.stderr.on("data", (chunk: Buffer) => onOutput(chunk));
        child.on("error", reject);
        child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code ?? -1}`))
        );
    });
}
