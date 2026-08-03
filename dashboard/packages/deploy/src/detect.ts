/**
 * Working out how to build and run a repository that has no Dockerfile.
 *
 * Nixpacks does its own detection, and for a plain project it is enough. What it
 * cannot do is the two cases people actually hit: a project whose framework
 * implies how to start it but whose package.json has no `start` script, and a
 * monorepo, where the lockfile and the shared packages live above the app so the
 * build has to run from the repository root while the commands point at one
 * workspace. Both end as "No start command could be found", which reads as a
 * broken platform rather than as a missing line in a manifest.
 *
 * So this decides those two things and writes them down; nixpacks is still the
 * builder. Everything here is pure - the caller reads the files and passes what it
 * found - and it deliberately answers `null` for anything it does not recognize,
 * which leaves nixpacks' own providers in charge of Python, Go, Rust and the rest
 * instead of guessing over them.
 */

/** The parts of a package.json this needs. */
export interface PackageManifest {
    readonly name?: string;
    readonly scripts?: Readonly<Record<string, string>>;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
    readonly workspaces?: unknown;
}

/** One directory the caller read on the way down to the service. */
export interface DirectorySnapshot {
    /** Path relative to the repository root. Empty is the repository root. */
    readonly path: string;
    /** File and directory names directly inside it. */
    readonly files: readonly string[];
    readonly manifest?: PackageManifest;
}

/**
 * What the caller found on disk: the repository root first, then each directory
 * down to the service's root directory, the service's own last. A service at the
 * repository root is a single entry.
 *
 * Every level is read because the workspace root is not necessarily the repository
 * root - a repository can hold a Rust workspace and a JavaScript one side by side,
 * and the lockfile that decides the package manager sits with whichever one the
 * app belongs to, not at the top.
 */
export interface RepoSnapshot {
    readonly levels: readonly DirectorySnapshot[];
}

/** How to build and start a repository, in the terms nixpacks takes. */
export interface DetectedBuild {
    /** The framework's name, for the log and the settings screen. */
    readonly framework: string;
    /** Where nixpacks is pointed, relative to the repository. Empty is the root -
     *  which is where a workspace has to build from, whatever the service's own
     *  root directory says. */
    readonly buildRoot: string;
    /**
     * Always null. Nixpacks installs dependencies correctly on its own - and its
     * install phase is also where it bootstraps the package manager, so replacing
     * that phase takes the bootstrap with it and the build dies on
     * "pnpm: command not found". Kept as a field because a service may still set
     * one by hand, which is a deliberate choice rather than a restatement of what
     * would have happened anyway.
     */
    readonly install: null;
    readonly build: string | null;
    readonly start: string | null;
    /** Nix packages the start command needs. A built site needs something to serve
     *  it; a server framework serves itself and needs none. */
    readonly packages: readonly string[];
    /** One line for the deployment log, so a wrong guess is diagnosable from the
     *  output rather than from the source. */
    readonly note: string;
}

/** A JavaScript package manager, decided by the lockfile that is present. */
type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

/**
 * A framework worth knowing about: what names it, whether it serves itself, and
 * what to run when the project never wrote a `start` script.
 *
 * `dist` is what a build leaves behind for the frameworks that do not serve
 * themselves - those are served by a static file server rather than started.
 */
interface Framework {
    readonly dep: string;
    readonly label: string;
    /** Present when the framework runs a server of its own. */
    readonly start?: string;
    /** Present when the build output is files to be served. */
    readonly dist?: string;
    /** A dependency that turns a static framework into a server one. */
    readonly serverDep?: string;
    readonly serverStart?: string;
}

/** Ordered: the first match wins, so a meta-framework is recognized before the
 *  view library it is built on (Next before React, Nuxt before Vue). */
const FRAMEWORKS: readonly Framework[] = [
    { dep: "next", label: "Next.js", start: "next start" },
    { dep: "nuxt", label: "Nuxt", start: "node .output/server/index.mjs" },
    { dep: "@remix-run/serve", label: "Remix", start: "remix-serve ./build/server/index.js" },
    { dep: "@sveltejs/kit", label: "SvelteKit", start: "node build", dist: "build" },
    {
        dep: "astro",
        label: "Astro",
        dist: "dist",
        serverDep: "@astrojs/node",
        serverStart: "node ./dist/server/entry.mjs"
    },
    { dep: "@nestjs/core", label: "NestJS", start: "node dist/main.js" },
    { dep: "@angular/core", label: "Angular", dist: "dist" },
    { dep: "vue", label: "Vue", dist: "dist" },
    { dep: "react-scripts", label: "Create React App", dist: "build" },
    { dep: "vite", label: "Vite", dist: "dist" },
    { dep: "fastify", label: "Fastify" },
    { dep: "express", label: "Express" }
];

/** Every dependency a manifest declares, however it declares it. */
function dependencies(manifest: PackageManifest): Readonly<Record<string, string>> {
    return { ...manifest.dependencies, ...manifest.devDependencies };
}

/** The package manager the install will use, read from the directory it runs in -
 *  which is the workspace root when there is one, not the repository root. */
function packageManager(files: readonly string[]): PackageManager {
    if (files.includes("pnpm-lock.yaml")) return "pnpm";
    if (files.includes("yarn.lock")) return "yarn";
    if (files.includes("bun.lockb") || files.includes("bun.lock")) return "bun";
    return "npm";
}

/** Whether a directory declares itself the root of a workspace. */
function declaresWorkspace(level: DirectorySnapshot): boolean {
    return level.files.includes("pnpm-workspace.yaml") || level.manifest?.workspaces !== undefined;
}

/**
 * The directory the build has to run from: the nearest ancestor of the service
 * that declares a workspace, because that is where the lockfile is and what the
 * shared packages resolve against. Null when the service is not inside one, which
 * is the ordinary case and builds from the service's own directory.
 *
 * Nearest rather than highest: nested workspaces exist, and the one that owns this
 * app is the closest one above it.
 */
function workspaceRoot(levels: readonly DirectorySnapshot[]): DirectorySnapshot | null {
    for (let at = levels.length - 2; at >= 0; at -= 1) {
        const level = levels[at];
        if (level && declaresWorkspace(level)) return level;
    }
    return null;
}

/** Run one of the app's own scripts, from the build root. `workspace` is the
 *  package name when the build runs from a workspace root and has to be pointed
 *  at one member, and null when it runs in the app's own directory. */
function runScript(manager: PackageManager, script: string, workspace: string | null): string {
    if (!workspace) return manager === "yarn" ? `yarn ${script}` : `${manager} run ${script}`;
    switch (manager) {
        case "pnpm":
            return `pnpm --filter ${workspace} run ${script}`;
        case "yarn":
            return `yarn workspace ${workspace} ${script}`;
        case "bun":
            return `bun run --filter ${workspace} ${script}`;
        case "npm":
            return `npm run ${script} -w ${workspace}`;
    }
}

/** Run a bare command inside the app's directory, for a framework default that is
 *  not one of the project's own scripts. */
function inDirectory(directory: string, command: string): string {
    return directory ? `cd ${directory} && ${command}` : command;
}

/**
 * Decide how to build and run this repository, or null when nothing here knows
 * better than nixpacks does. Null is the common answer for a Python or Go project
 * and for a plain Node app with a `start` script - both of which nixpacks already
 * handles, and neither of which is improved by being second-guessed.
 */
export function detectBuild(snapshot: RepoSnapshot): DetectedBuild | null {
    const app = snapshot.levels[snapshot.levels.length - 1];
    if (!app?.manifest) return null;

    const enclosing = workspaceRoot(snapshot.levels);
    // A workspace member is addressed by its package name; without one there is
    // nothing to point `--filter` at, so there is no honest way to build it.
    const workspace = enclosing ? (app.manifest.name ?? null) : null;
    if (enclosing && !workspace) return null;

    const workspaceBuild = enclosing !== null;
    const appDirectory = app.path;
    const buildRoot = enclosing ? enclosing.path : appDirectory;
    // The install runs where the build is rooted, so that is where the lockfile
    // that names the package manager has to be read from.
    const manager = packageManager((enclosing ?? app).files);
    /** The app's directory as seen from the build root, for a command that has to
     *  cd into it. */
    const appFromBuildRoot =
        enclosing && appDirectory.startsWith(`${enclosing.path}/`)
            ? appDirectory.slice(enclosing.path.length + 1)
            : enclosing
              ? appDirectory
              : "";

    const manifest = app.manifest;
    const deps = dependencies(manifest);
    const framework = FRAMEWORKS.find((entry) => entry.dep in deps);
    const scripts = manifest.scripts ?? {};

    // Pointed at a workspace root rather than at an app in it. Nothing here can be
    // started - a workspace root is a container, and its build script builds every
    // member - so say which mistake it is. Left to the builder this is the opaque
    // "No start command could be found", which reads as Polaris being broken rather
    // than as one field being set to the wrong directory.
    if (!framework && !scripts.start && declaresWorkspace(app)) {
        return {
            framework: "Workspace",
            buildRoot,
            install: null,
            build: null,
            start: null,
            packages: [],
            note: "a workspace root rather than an app - set the root directory to the app inside it you want to deploy"
        };
    }

    // Nothing to add: a plain Node project that says how to start itself, and no
    // workspace to point the commands at, is exactly what nixpacks already does.
    if (!framework && !workspaceBuild) return null;

    const build = scripts.build ? runScript(manager, "build", workspace) : null;
    const packages: string[] = [];
    let start: string | null = null;
    let note: string;

    const servesItself = framework?.start ?? (framework?.serverDep && framework.serverDep in deps ? framework.serverStart : undefined);
    const label = framework?.label ?? "Node.js";

    if (scripts.start) {
        start = runScript(manager, "start", workspace);
        note = `${label}, started with its own start script`;
    } else if (servesItself) {
        // The framework knows how to serve itself; run it from the app's directory,
        // since the build may be rooted above it.
        start = inDirectory(appFromBuildRoot, servesItself);
        note = `${label}, started the way ${label} starts`;
    } else if (framework?.dist) {
        // A built site is files, not a process. Serve them with a real static server
        // rather than leaving the container with nothing to run - caddy comes from
        // nixpacks' own package set, so nothing is downloaded at boot.
        const directory = [appFromBuildRoot, framework.dist].filter(Boolean).join("/");
        packages.push("caddy");
        start = `caddy file-server --root ${directory} --listen :\${PORT:-3000}`;
        note = `${label}, a built site served from ${directory}`;
    } else {
        // Recognized the stack but not how to run it. Better to say so than to
        // invent a command that fails at boot instead of at build.
        note = `${label}, but nothing here says how to start it - set a start command`;
    }

    return {
        framework: label,
        buildRoot,
        install: null,
        build,
        start,
        packages,
        note: workspaceBuild ? `${note}; built from the workspace root for ${workspace}` : note
    };
}
