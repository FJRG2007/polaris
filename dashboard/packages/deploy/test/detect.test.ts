/**
 * Working out how to build a repository that has no Dockerfile.
 *
 * The case that drove this: a monorepo whose root package.json has no `start`
 * script and whose app lives in a subdirectory. Nixpacks pointed at the root
 * builds it and then has nothing to run - "No start command could be found" - and
 * pointed at the subdirectory it cannot install, because the lockfile is above it.
 * The answer is to build from the workspace root and scope the commands to the one
 * member, which is what most of these pin down.
 *
 * The workspace root is deliberately not assumed to be the repository root. A
 * repository can hold a Rust workspace at the top and the JavaScript one two
 * levels down, and the lockfile that decides the package manager sits with
 * whichever one the app belongs to.
 *
 * The other half is restraint: answering null for anything nixpacks already
 * handles. Second-guessing a Python project, or a plain Node app that says how to
 * start itself, can only make a working deploy worse.
 */

import { describe, expect, it } from "vitest";
import { detectBuild, type DirectorySnapshot, type RepoSnapshot } from "../src/detect.js";

/** A repository holding one app at its root. */
function alone(level: Partial<DirectorySnapshot>): RepoSnapshot {
    return { levels: [{ path: "", files: ["package.json", "package-lock.json"], ...level }] };
}

/** A pnpm workspace at the repository root, with the service at apps/web. */
function workspace(manifest: DirectorySnapshot["manifest"], lock = "pnpm-lock.yaml"): RepoSnapshot {
    return {
        levels: [
            {
                path: "",
                files: ["package.json", lock, "pnpm-workspace.yaml"],
                manifest: { workspaces: ["apps/*"] }
            },
            { path: "apps", files: ["web"] },
            { path: "apps/web", files: ["package.json"], manifest }
        ]
    };
}

describe("nothing to add", () => {
    it("leaves a project with no package.json to nixpacks", () => {
        expect(detectBuild({ levels: [{ path: "", files: ["requirements.txt", "main.py"] }] })).toBeNull();
    });

    it("leaves a plain Node app that starts itself to nixpacks", () => {
        expect(detectBuild(alone({ manifest: { scripts: { start: "node index.js" } } }))).toBeNull();
    });

    it("gives up rather than guess when a workspace member has no name to filter on", () => {
        expect(detectBuild(workspace({ scripts: { build: "next build" }, dependencies: { next: "15" } }))).toBeNull();
    });
});

describe("a framework that never wrote a start script", () => {
    it("starts Next.js the way Next.js starts", () => {
        const plan = detectBuild(alone({ manifest: { scripts: { build: "next build" }, dependencies: { next: "15" } } }));
        expect(plan?.framework).toBe("Next.js");
        expect(plan?.start).toBe("next start");
        expect(plan?.build).toBe("npm run build");
        expect(plan?.install).toBe("npm ci");
    });

    it("prefers the project's own start script over the framework default", () => {
        const plan = detectBuild(
            alone({ manifest: { scripts: { build: "next build", start: "next start -p 8080" }, dependencies: { next: "15" } } })
        );
        expect(plan?.start).toBe("npm run start");
    });

    it("recognizes a meta-framework before the view library under it", () => {
        expect(detectBuild(alone({ manifest: { dependencies: { next: "15", react: "19" } } }))?.framework).toBe("Next.js");
    });

    it("says so plainly when it knows the stack but not how to run it", () => {
        const plan = detectBuild(workspace({ name: "@acme/lib", scripts: { build: "tsc" } }));
        expect(plan?.start).toBeNull();
        expect(plan?.note).toContain("set a start command");
    });
});

describe("a built site is not a process", () => {
    it("serves an Astro build instead of leaving nothing to run", () => {
        const plan = detectBuild(alone({ manifest: { scripts: { build: "astro build" }, dependencies: { astro: "5" } } }));
        expect(plan?.framework).toBe("Astro");
        expect(plan?.packages).toEqual(["caddy"]);
        expect(plan?.start).toBe("caddy file-server --root dist --listen :${PORT:-3000}");
    });

    it("starts Astro as a server once it has the node adapter", () => {
        const plan = detectBuild(alone({ manifest: { dependencies: { astro: "5", "@astrojs/node": "9" } } }));
        expect(plan?.start).toBe("node ./dist/server/entry.mjs");
        expect(plan?.packages).toEqual([]);
    });

    it("serves the output from inside the app directory in a workspace", () => {
        const plan = detectBuild(workspace({ name: "web", scripts: { build: "vite build" }, dependencies: { vite: "6" } }));
        expect(plan?.start).toBe("caddy file-server --root apps/web/dist --listen :${PORT:-3000}");
    });
});

describe("a monorepo builds from the workspace root", () => {
    const snapshot = workspace({
        name: "@polaris/web",
        scripts: { build: "next build", start: "next start" },
        dependencies: { next: "15" }
    });

    it("points the build at the workspace root, not the app", () => {
        // The lockfile and the shared packages live above the app; pointed at the
        // app, the install has nothing to install against.
        expect(detectBuild(snapshot)?.buildRoot).toBe("");
    });

    it("scopes every script to the one workspace", () => {
        const plan = detectBuild(snapshot);
        expect(plan?.install).toBe("pnpm install --frozen-lockfile");
        expect(plan?.build).toBe("pnpm --filter @polaris/web run build");
        expect(plan?.start).toBe("pnpm --filter @polaris/web run start");
    });

    it("runs a framework default inside the app directory, since the build is above it", () => {
        const noStart = workspace({ name: "@polaris/web", scripts: { build: "next build" }, dependencies: { next: "15" } });
        expect(detectBuild(noStart)?.start).toBe("cd apps/web && next start");
    });

    it("says which workspace it built, so a wrong guess is readable from the log", () => {
        expect(detectBuild(snapshot)?.note).toContain("@polaris/web");
    });

    it("builds from the app itself when nothing above it declares a workspace", () => {
        const plan = detectBuild({
            levels: [
                { path: "", files: ["README.md"] },
                {
                    path: "service",
                    files: ["package.json"],
                    manifest: { name: "svc", scripts: { build: "tsc", start: "node ." }, dependencies: { express: "4" } }
                }
            ]
        });
        expect(plan?.buildRoot).toBe("service");
        expect(plan?.build).toBe("npm run build");
    });
});

describe("pointed at a workspace root instead of at an app", () => {
    /** What a service configured with `dashboard` rather than `dashboard/apps/web`
     *  sees: a manifest that lists members and builds all of them. */
    const atTheWorkspace: RepoSnapshot = {
        levels: [
            { path: "", files: ["Cargo.toml", "dashboard"] },
            {
                path: "dashboard",
                files: ["package.json", "package-lock.json"],
                manifest: { workspaces: ["apps/*"], scripts: { build: "npm run build --workspaces" } }
            }
        ]
    };

    it("names the mistake instead of leaving the builder to fail opaquely", () => {
        const plan = detectBuild(atTheWorkspace);
        expect(plan?.start).toBeNull();
        expect(plan?.note).toContain("set the root directory to the app inside it");
    });

    it("writes no commands, since there is no one app to build", () => {
        const plan = detectBuild(atTheWorkspace);
        expect(plan?.install).toBeNull();
        expect(plan?.build).toBeNull();
    });

    it("stays out of the way when the workspace root is itself runnable", () => {
        // A repository whose root is both the workspace and the app - it says how to
        // start itself, so there is nothing to correct.
        const runnable: RepoSnapshot = {
            levels: [
                {
                    path: "",
                    files: ["package.json", "package-lock.json"],
                    manifest: { workspaces: ["packages/*"], scripts: { start: "node server.js" } }
                }
            ]
        };
        expect(detectBuild(runnable)).toBeNull();
    });
});

describe("the workspace root is not always the repository root", () => {
    /** A repository whose top level is not JavaScript at all - a Rust workspace,
     *  say - with the JavaScript one under it. */
    const nested: RepoSnapshot = {
        levels: [
            { path: "", files: ["Cargo.toml", "crates", "dashboard"] },
            {
                path: "dashboard",
                files: ["package.json", "pnpm-lock.yaml"],
                manifest: { workspaces: ["apps/*", "packages/*"] }
            },
            { path: "dashboard/apps", files: ["web"] },
            {
                path: "dashboard/apps/web",
                files: ["package.json"],
                manifest: { name: "@polaris/web", scripts: { build: "next build", start: "next start" }, dependencies: { next: "15" } }
            }
        ]
    };

    it("builds from the workspace it found, not from the top of the repository", () => {
        expect(detectBuild(nested)?.buildRoot).toBe("dashboard");
    });

    it("reads the package manager from where the install will actually run", () => {
        // The repository root has no lockfile at all; npm would be the wrong answer.
        expect(detectBuild(nested)?.install).toBe("pnpm install --frozen-lockfile");
    });

    it("still scopes the scripts to the member", () => {
        expect(detectBuild(nested)?.build).toBe("pnpm --filter @polaris/web run build");
    });

    it("writes a cd relative to the build root, not to the repository", () => {
        const noStart: RepoSnapshot = {
            levels: nested.levels.map((level) =>
                level.path === "dashboard/apps/web"
                    ? { ...level, manifest: { name: "@polaris/web", scripts: { build: "next build" }, dependencies: { next: "15" } } }
                    : level
            )
        };
        expect(detectBuild(noStart)?.start).toBe("cd apps/web && next start");
    });

    it("picks the nearest workspace above the app when there are two", () => {
        const twice: RepoSnapshot = {
            levels: [
                { path: "", files: ["package.json", "package-lock.json"], manifest: { workspaces: ["*"] } },
                { path: "inner", files: ["package.json", "yarn.lock"], manifest: { workspaces: ["apps/*"] } },
                {
                    path: "inner/app",
                    files: ["package.json"],
                    manifest: { name: "app", scripts: { build: "vite build", start: "node ." }, dependencies: { next: "15" } }
                }
            ]
        };
        const plan = detectBuild(twice);
        expect(plan?.buildRoot).toBe("inner");
        expect(plan?.install).toBe("yarn install --frozen-lockfile");
    });
});

describe("the package manager comes from the lockfile", () => {
    const manifest = { scripts: { build: "vite build", start: "node ." }, dependencies: { next: "15" } };

    it("reads pnpm, yarn, bun and npm", () => {
        const at = (lock: string) => detectBuild(alone({ files: ["package.json", lock], manifest }));
        expect(at("pnpm-lock.yaml")?.install).toBe("pnpm install --frozen-lockfile");
        expect(at("yarn.lock")?.install).toBe("yarn install --frozen-lockfile");
        expect(at("bun.lockb")?.install).toBe("bun install");
        expect(at("package-lock.json")?.install).toBe("npm ci");
    });

    it("installs rather than ci when npm has no lockfile to go on", () => {
        // `npm ci` refuses without one, which would turn a missing file into a
        // failed build for no reason.
        expect(detectBuild(alone({ files: ["package.json"], manifest }))?.install).toBe("npm install");
    });

    it("uses each manager's own way of addressing a workspace", () => {
        const member = { name: "web", scripts: { build: "next build", start: "next start" }, dependencies: { next: "15" } };
        const at = (lock: string) => detectBuild(workspace(member, lock));
        expect(at("pnpm-lock.yaml")?.build).toBe("pnpm --filter web run build");
        expect(at("yarn.lock")?.build).toBe("yarn workspace web build");
        expect(at("bun.lockb")?.build).toBe("bun run --filter web build");
        expect(at("package-lock.json")?.build).toBe("npm run build -w web");
    });
});
