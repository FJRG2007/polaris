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
    readonly engines?: Readonly<Record<string, string>>;
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
    /** The Node range this project declares, when the auto-detecting builder is
     *  unlikely to meet it. Reported, never acted on - see unmetNodeRequirement. */
    readonly nodeRequirement: string | null;
    /**
     * Everything needed to write a Dockerfile for this project, which is how it is
     * actually built. Present for anything recognized here; absent leaves the whole
     * job to the auto-detecting builder.
     *
     * These commands are complete rather than "only what differs": a Dockerfile has
     * no builder underneath it to defer the rest to.
     */
    readonly image: {
        readonly buildImage: string;
        readonly runtimeImage: string;
        /** The app's directory relative to the repository root. */
        readonly appDirectory: string;
        /** The install that runs at the repository root, for a workspace. */
        readonly workspaceInstall: string | null;
        readonly install: string | null;
        readonly build: string | null;
        readonly start: string | null;
        /** Built files to serve, relative to the app, rather than a process. */
        readonly staticDirectory: string | null;
    } | null;
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
    /** Adapters that aim the build at somebody else's platform. The output is
     *  theirs, not a container's, so neither serving nor starting it works. */
    readonly foreignAdapters?: readonly string[];
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
        serverStart: "node ./dist/server/entry.mjs",
        foreignAdapters: ["@astrojs/vercel", "@astrojs/netlify", "@astrojs/cloudflare"]
    },
    { dep: "@nestjs/core", label: "NestJS", start: "node dist/main.js" },
    // No `dist`: Angular writes dist/<project>/browser, and the project name is in
    // angular.json rather than anywhere read here. Serving the wrong directory
    // builds cleanly and then serves a file listing, which is worse than saying
    // nothing and letting the operator name the start command.
    { dep: "@angular/core", label: "Angular" },
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

/** The Node major to build on: what the project asks for, or a current default.
 *  A tag like `node:22-slim` is the newest 22.x whenever it is pulled, so a
 *  declared minimum inside a major is satisfied without anything being pinned. */
export function nodeImageMajor(range: string | undefined): string {
    const declared = range?.trim() ? /(\d+)/.exec(range.trim())?.[1] : undefined;
    const major = declared ? Number(declared) : 0;
    // Below 18 is out of support everywhere; asking for it usually means the
    // manifest was written years ago and never revisited.
    return major >= 18 ? String(major) : DEFAULT_NODE_MAJOR;
}

/** What a project gets when it does not say. Current LTS rather than the oldest
 *  thing that still runs. */
const DEFAULT_NODE_MAJOR = "22";

/**
 * A Node requirement the builder is likely to refuse, or null.
 *
 * The builder maps a major to one pinned release - its `nodejs_22` is one specific
 * 22.x, not the newest - so a project needing a version from *inside* a major gets
 * something older than it asked for and fails its own engine check. Astro asking
 * for >=22.12.0 lands on 22.3.0 and refuses to build.
 *
 * This only reports it, and the reason is worth writing down. Asking for a
 * different major was tried and is worse: which majors a builder carries depends
 * on its version, and naming one it does not have does not error - it falls all
 * the way back to its default, turning a Node 22 build into a Node 18 one. The
 * actual fix is upstream of here: a current builder resolves `>=22.12.0` to a
 * major that satisfies it without being asked, which is why onboarding pins and
 * upgrades one rather than using whatever the machine happens to carry.
 */
export function unmetNodeRequirement(range: string | undefined): string | null {
    if (!range) return null;
    const wanted = range.trim();
    const minimum = /(?:>=?\s*)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(wanted);
    if (!minimum) return null;
    // A major's own .0 satisfies it, which is what the builder provides.
    if (Number(minimum[2] ?? 0) === 0 && Number(minimum[3] ?? 0) === 0) return null;
    return wanted;
}

/** What this project says it needs to run on, nearest declaration first. */
function declaredNodeRange(levels: readonly DirectorySnapshot[]): string | undefined {
    for (let at = levels.length - 1; at >= 0; at -= 1) {
        const engines = levels[at]?.manifest?.engines;
        if (engines?.node) return engines.node;
    }
    return undefined;
}

/** The install command for a package manager, run wherever the lockfile is. */
function installCommand(manager: PackageManager, files: readonly string[]): string {
    switch (manager) {
        case "pnpm":
            return "pnpm install --frozen-lockfile";
        case "yarn":
            return "yarn install --frozen-lockfile";
        case "bun":
            return "bun install";
        case "npm":
            // `npm ci` needs a lockfile and refuses without one.
            return files.includes("package-lock.json") ? "npm ci" : "npm install";
    }
}

/** The image a package manager runs in. Bun is its own runtime and ships its own;
 *  everything else runs on Node, which carries npm and a corepack shim for the
 *  other two. */
function baseImage(manager: PackageManager, nodeMajor: string): string {
    return manager === "bun" ? "oven/bun:1" : `node:${nodeMajor}-slim`;
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
    const nodeRequirement = unmetNodeRequirement(declaredNodeRange(snapshot.levels));

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
            nodeRequirement,
            image: null,
            note: "a workspace root rather than an app - set the root directory to the app inside it you want to deploy"
        };
    }

    // Nothing to add: a plain Node project that says how to start itself, and no
    // workspace to point the commands at, is exactly what nixpacks already does.
    if (!framework && !workspaceBuild) return null;

    // Only when it has to differ. Outside a workspace the command is exactly what
    // the builder would have run, and overriding a phase to restate it is how the
    // install phase lost its package-manager bootstrap - the same trap, one phase
    // along.
    const build = scripts.build && workspace ? runScript(manager, "build", workspace) : null;
    const packages: string[] = [];
    let start: string | null = null;
    let note: string;

    const servesItself = framework?.start ?? (framework?.serverDep && framework.serverDep in deps ? framework.serverStart : undefined);
    const label = framework?.label ?? "Node.js";
    const foreignAdapter = framework?.foreignAdapters?.find((adapter) => adapter in deps);

    if (scripts.start) {
        // Same rule: outside a workspace the builder already runs this script, and
        // says so itself.
        start = workspace ? runScript(manager, "start", workspace) : null;
        note = `${label}, started with its own start script`;
    } else if (servesItself) {
        // The framework knows how to serve itself; run it from the app's directory,
        // since the build may be rooted above it.
        start = inDirectory(appFromBuildRoot, servesItself);
        note = `${label}, started the way ${label} starts`;
    } else if (foreignAdapter) {
        // The build is aimed at another platform: its output is that platform's
        // bundle, not files to serve or a server to start. Guessing either way
        // produces a container that builds and then serves nothing, which is worse
        // than saying what the one required change is.
        note = `${label} building for ${foreignAdapter} - swap the adapter for @astrojs/node to deploy it here`;
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

    // What the image is actually built from. The commands here are complete and
    // unscoped: a Dockerfile puts the app's own directory under WORKDIR, so a
    // script runs where it lives and no `--filter` or `cd` is needed. A workspace
    // installs once at its root, which is where its lockfile is.
    const nodeMajor = nodeImageMajor(declaredNodeRange(snapshot.levels));
    const image = baseImage(manager, nodeMajor);
    const rootInstall = installCommand(manager, (enclosing ?? app).files);
    const staticDirectory = !scripts.start && !servesItself && !foreignAdapter ? (framework?.dist ?? null) : null;

    if (nodeRequirement) note = `${note}; on Node ${nodeMajor}, which is what it asks for`;
    else if (!foreignAdapter) note = `${note}; on Node ${nodeMajor}`;

    return {
        framework: label,
        buildRoot,
        install: null,
        build,
        start,
        packages,
        nodeRequirement,
        image: foreignAdapter
            ? null
            : {
                  buildImage: image,
                  runtimeImage: image,
                  appDirectory,
                  workspaceInstall: workspaceBuild ? rootInstall : null,
                  install: workspaceBuild ? null : rootInstall,
                  build: scripts.build ? runScript(manager, "build", null) : null,
                  start: scripts.start
                      ? runScript(manager, "start", null)
                      : (servesItself ?? null),
                  staticDirectory
              },
        note: workspaceBuild ? `${note}; built from the workspace root for ${workspace}` : note
    };
}
