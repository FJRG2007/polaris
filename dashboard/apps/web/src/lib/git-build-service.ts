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
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { lstat, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import {
    detectBuild,
    generateDockerfile,
    GENERATED_DOCKERFILE,
    INSTALL_ENV,
    LANGUAGE_FILES,
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
    /**
     * What more can be said about a refusal, asked of the forge itself.
     *
     * Optional and asked only when the clone was refused for want of an account:
     * this module knows git and nothing about whoever is hosting the repository,
     * and every question worth asking here - has the token expired, was this
     * account ever given this repository, does the organization want its SSO
     * authorized - is one only they can answer.
     */
    explain?: () => Promise<string | null>;
    /**
     * The exact commit to build, when one is known.
     *
     * A push announces a commit, and the build used to clone whatever the branch
     * head was by the time the queue reached it - so two pushes a minute apart
     * could both build the second one, and the first deployment would carry a
     * commit it never ran. With this the clone is moved to the named commit.
     */
    commitSha?: string;
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
    /** Build Python, Go, Rust, PHP, Ruby, Java, Elixir and static sites from a
     *  generated image as well (see `DetectOptions.languages`). */
    languages?: boolean;
    /** The runtime version the service set ("20", "3.11", "1.22"). */
    runtimeVersion?: string | null;
    /** Where a built site's files are, relative to the service's directory, when
     *  the framework's own default is not it. */
    outputDirectory?: string | null;
}

/** The most of one manifest read for detection. A manifest is a few kilobytes; a
 *  file this size named like one is not something detection should hold. */
const MANIFEST_LIMIT = 64 * 1024;

/** The most of a package.json read. Larger than the others, because a package.json
 *  is also where a project keeps the configuration of half its tools. */
const PACKAGE_LIMIT = 1024 * 1024;

/**
 * Whether `path` is inside the checkout at `root` once every link on the way is
 * followed. A repository can ship a symlink, and a service can name a directory
 * with a "..", so a path joined under the checkout can still land anywhere on
 * this machine.
 */
async function insideCheckout(root: string, path: string): Promise<boolean> {
    try {
        const [base, real] = await Promise.all([realpath(root), realpath(path)]);
        const rest = relative(base, real);
        return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
    } catch {
        return false;
    }
}

/**
 * The text of a file the repository holds, or null when it is anything but a
 * regular file inside the checkout of at most `limit` bytes. Never follows a
 * link, and never reads more than the limit, so a manifest that is really
 * /dev/zero or a file of this machine's is simply not there.
 */
async function readRepoFile(root: string, path: string, limit: number): Promise<string | null> {
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.size > limit || !(await insideCheckout(root, dirname(path)))) return null;
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            const buffer = Buffer.alloc(info.size + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            return bytesRead > limit ? null : buffer.toString("utf8", 0, bytesRead);
        } finally {
            await handle.close();
        }
    } catch {
        return null;
    }
}

/**
 * Write a file into the checkout as a new file. Whatever the repository had at
 * that name goes first, and the write refuses to follow a link, so a symlink
 * shipped under the name cannot aim the write at a file of this machine's.
 */
async function writeRepoFile(root: string, path: string, text: string): Promise<void> {
    if (!(await insideCheckout(root, dirname(path)))) {
        throw new Error(`${relative(root, path)} would be written outside the repository`);
    }
    await rm(path, { force: true });
    await writeFile(path, text, { encoding: "utf8", flag: "wx" });
}

/** The text of the detection manifests present in a directory. */
async function readTexts(root: string, directory: string, files: readonly string[]): Promise<Record<string, string>> {
    const texts: Record<string, string> = {};
    for (const name of LANGUAGE_FILES) {
        if (!files.includes(name)) continue;
        // Unreadable is the same as absent here.
        const text = await readRepoFile(root, join(directory, name), MANIFEST_LIMIT);
        if (text !== null) texts[name] = text;
    }
    return texts;
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
async function readManifest(root: string, directory: string): Promise<PackageManifest | undefined> {
    const text = await readRepoFile(root, join(directory, "package.json"), PACKAGE_LIMIT);
    if (text === null) return undefined;
    try {
        return JSON.parse(text) as PackageManifest;
    } catch {
        return undefined;
    }
}

/** A directory's entries, or none when it is not a directory inside the checkout. */
async function listDirectory(root: string, directory: string): Promise<string[]> {
    try {
        return (await insideCheckout(root, directory)) ? await readdir(directory) : [];
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
        paths.map(async (path, at) => {
            const directory = path ? join(dir, path) : dir;
            const [files, manifest] = await Promise.all([listDirectory(dir, directory), readManifest(dir, directory)]);
            // Only the service's own directory is read for the other languages'
            // manifests; the levels above it only matter to a JavaScript workspace.
            const texts = at === paths.length - 1 ? await readTexts(dir, directory, files) : undefined;
            return { path, files, manifest, texts };
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
 *
 * Exported for its test, which runs it against a directory rather than a clone.
 */
export async function configureBuild(
    dir: string,
    commands: BuildCommands,
    log: (line: string) => void
): Promise<{ root?: string; dockerfile?: string }> {
    const rootDirectory = commands.rootDirectory || undefined;
    const detected = await snapshot(dir, rootDirectory).then((found) =>
        detectBuild(found, { languages: commands.languages, runtimeVersion: commands.runtimeVersion })
    );
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
            start: commands.startCommand || detected.image.start,
            // Only a built site has an output directory to point elsewhere.
            staticDirectory:
                detected.image.staticDirectory !== null && commands.outputDirectory
                    ? commands.outputDirectory
                    : detected.image.staticDirectory
        };
        await writeRepoFile(
            dir,
            join(dir, GENERATED_DOCKERFILE),
            generateDockerfile({ ...detected.image, ...overridden, port: commands.port ?? 3000 })
        );
        log(`Building on ${detected.image.buildImage}.\n`);
        return { dockerfile: GENERATED_DOCKERFILE };
    }

    const entries = await listDirectory(dir, configDir);
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

    if (config) await writeRepoFile(dir, join(configDir, "nixpacks.toml"), config);
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
            const refusal = cloneRefusal(said, source);
            if (!refusal) throw new Error(error instanceof Error ? error.message : "the clone failed");
            const more = source.explain ? await source.explain().catch(() => null) : null;
            throw new Error(more ? `${refusal} ${more}` : refusal);
        }

        // Moved to the commit this deploy is for, when the branch has gone past
        // it. Fetched on its own, one commit deep, with the same credential - a
        // forge answers a fetch of a commit reachable from its branches.
        if (source.commitSha) {
            try {
                await checkoutCommit(dir, source, watched);
            } catch (error) {
                await rm(dir, { recursive: true, force: true });
                throw new Error(
                    `Commit ${source.commitSha.slice(0, 7)} could not be fetched: ${error instanceof Error ? error.message : "the fetch failed"}`
                );
            }
        }

        return contextFromDirectory(dir, onOutput, commands);
    };
}

/**
 * A build context from a directory already holding the source - a clone, or an
 * uploaded folder unpacked: work out how to build it, then stream a tar of it.
 * The directory is removed once the tar has been read.
 */
export async function contextFromDirectory(
    dir: string,
    onOutput: (chunk: Buffer) => void,
    commands?: BuildCommands
): Promise<BuildContext> {
    const log = (line: string): void => onOutput(Buffer.from(line));
    // Best-effort: a source that defeats detection still deploys exactly as it
    // did before, with the builder left to its own devices.
    let configured: { root?: string; dockerfile?: string } = {};
    if (commands) {
        try {
            configured = await configureBuild(dir, commands, log);
        } catch (error) {
            log(`Could not inspect the source: ${error instanceof Error ? error.message : "unknown error"}\n`);
        }
    }

    // Tar the working tree (excluding any .git dir) as the build context.
    const child = spawn("tar", ["-C", dir, "--exclude=./.git", "-c", "."]);
    child.stderr.on("data", (chunk: Buffer) => onOutput(chunk));
    const cleanup = (): void => void rm(dir, { recursive: true, force: true });
    child.stdout.on("close", cleanup);
    child.stdout.on("error", cleanup);
    return { tar: child.stdout, ...configured };
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

/** A full or abbreviated commit id, and nothing git would read as an option. */
const COMMIT_ID = /^[0-9a-f]{7,64}$/i;

/**
 * Put a fresh shallow clone on one named commit.
 *
 * Nothing is fetched when the branch head already is that commit, which is the
 * ordinary case: the deploy was started by the push that made it the head.
 */
async function checkoutCommit(
    dir: string,
    source: GitSource,
    onOutput: (chunk: Buffer) => void
): Promise<void> {
    const sha = source.commitSha ?? "";
    if (!COMMIT_ID.test(sha)) throw new Error("that is not a commit id");
    let head = "";
    await runCommand("git", ["-C", dir, "rev-parse", "HEAD"], (chunk) => {
        head += chunk.toString("utf8");
    });
    if (head.trim().toLowerCase().startsWith(sha.toLowerCase())) return;
    const config = source.authHeader ? ["-c", `http.extraHeader=${source.authHeader}`] : [];
    onOutput(Buffer.from(`The branch has moved on; building ${sha.slice(0, 7)} as this deploy asked.\n`));
    await runCommand("git", [...config, "-C", dir, "fetch", "--depth", "1", "origin", sha], onOutput, NO_PROMPTS);
    await runCommand("git", ["-C", dir, "checkout", "--detach", "FETCH_HEAD"], onOutput, NO_PROMPTS);
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
