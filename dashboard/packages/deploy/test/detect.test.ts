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
        // Nothing else: the builder runs `npm run build` and installs by itself,
        // and restating either only risks replacing a phase that was already right.
        expect(plan?.build).toBeNull();
        expect(plan?.install).toBeNull();
    });

    it("says nothing at all when the project already has a start script", () => {
        // The builder runs it. Overriding here would swap the project's own script
        // for a restatement of it, which can only lose.
        const plan = detectBuild(
            alone({ manifest: { scripts: { build: "next build", start: "next start -p 8080" }, dependencies: { next: "15" } } })
        );
        expect(plan?.start).toBeNull();
        expect(plan?.build).toBeNull();
        expect(plan?.note).toContain("its own start script");
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

    it("says what to change when the build is aimed at another platform", () => {
        // @astrojs/vercel writes .vercel/output, not a servable dist and not a
        // server. Serving `dist` would build cleanly and then serve nothing, which
        // is a worse answer than naming the one required change.
        const plan = detectBuild(
            alone({
                manifest: {
                    scripts: { build: "astro build" },
                    dependencies: { astro: "7", "@astrojs/vercel": "11" }
                }
            })
        );
        expect(plan?.start).toBeNull();
        expect(plan?.packages).toEqual([]);
        expect(plan?.note).toContain("@astrojs/vercel");
        expect(plan?.note).toContain("@astrojs/node");
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
        expect(plan?.install).toBeNull();
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
        // Not a workspace, so the builder's own commands are already right.
        expect(plan?.build).toBeNull();
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

    it("reads the package manager from where the build will actually run", () => {
        // The repository root has no lockfile at all; npm would be the wrong answer,
        // and it is the package manager that decides how a script is addressed.
        expect(detectBuild(nested)?.build).toBe("pnpm --filter @polaris/web run build");
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
        // yarn.lock is the inner one's, which is the workspace that owns this app.
        expect(plan?.build).toBe("yarn workspace app build");
    });
});

describe("the package manager comes from the lockfile", () => {
    it("uses each manager's own way of addressing a workspace", () => {
        const member = { name: "web", scripts: { build: "next build", start: "next start" }, dependencies: { next: "15" } };
        const at = (lock: string) => detectBuild(workspace(member, lock));
        expect(at("pnpm-lock.yaml")?.build).toBe("pnpm --filter web run build");
        expect(at("yarn.lock")?.build).toBe("yarn workspace web build");
        expect(at("bun.lockb")?.build).toBe("bun run --filter web build");
        expect(at("package-lock.json")?.build).toBe("npm run build -w web");
    });
});

describe("the runtime the project asks for", () => {
    /**
     * The failure that drove four wrong fixes: an Astro project declaring
     * >=22.12.0 got the auto-detecting builder's pinned 22.3.0 and refused to
     * build, and asking that builder for a newer major silently dropped it to 18.
     *
     * Writing a Dockerfile ends the argument. `node:22-slim` is the current 22.x
     * whenever it is pulled, so a declared minimum inside a major is satisfied
     * without anything here having to know which patch exists.
     */
    const astro = (node?: string) =>
        detectBuild(
            alone({
                files: ["package.json", "pnpm-lock.yaml"],
                manifest: {
                    scripts: { build: "astro build", start: "node ./dist/server/entry.mjs" },
                    dependencies: { astro: "7", "@astrojs/node": "11" },
                    ...(node ? { engines: { node } } : {})
                }
            })
        );

    it("builds on the major the project declares", () => {
        expect(astro(">=22.12.0")?.image?.buildImage).toBe("node:22-slim");
        expect(astro(">=24")?.image?.buildImage).toBe("node:24-slim");
    });

    it("uses a current default when the project never said", () => {
        // Not the builder's default of 18, which has been out of support for a while.
        expect(astro()?.image?.buildImage).toBe("node:22-slim");
    });

    it("ignores a declared version too old to be worth honouring", () => {
        expect(astro(">=14")?.image?.buildImage).toBe("node:22-slim");
    });

    it("puts bun on its own runtime rather than on Node", () => {
        const bun = detectBuild(
            alone({
                files: ["package.json", "bun.lockb"],
                manifest: { scripts: { start: "bun run index.ts" }, dependencies: { next: "15" } }
            })
        );
        expect(bun?.image?.buildImage).toBe("oven/bun:1");
    });

    it("says which runtime it picked, so the log carries it", () => {
        expect(astro(">=22.12.0")?.note).toContain("Node 22");
    });
});

describe("what the image is built from", () => {
    it("carries the complete commands, since a Dockerfile has nothing to defer to", () => {
        const plan = detectBuild(
            alone({
                files: ["package.json", "pnpm-lock.yaml"],
                manifest: { scripts: { build: "next build" }, dependencies: { next: "15" } }
            })
        );
        expect(plan?.image?.install).toBe("pnpm install --frozen-lockfile");
        expect(plan?.image?.build).toBe("pnpm run build");
        // No start script, so the framework's own way of starting.
        expect(plan?.image?.start).toBe("next start");
    });

    it("installs at the workspace root and builds unscoped inside the app", () => {
        const plan = detectBuild(
            workspace({ name: "web", scripts: { build: "next build", start: "next start" }, dependencies: { next: "15" } })
        );
        expect(plan?.image?.workspaceInstall).toBe("pnpm install --frozen-lockfile");
        expect(plan?.image?.install).toBeNull();
        // The Dockerfile's WORKDIR does the scoping, so no --filter is needed.
        expect(plan?.image?.build).toBe("pnpm run build");
        expect(plan?.image?.appDirectory).toBe("apps/web");
    });

    it("marks a built site as files to serve rather than a process", () => {
        const plan = detectBuild(alone({ manifest: { scripts: { build: "vite build" }, dependencies: { vite: "6" } } }));
        expect(plan?.image?.staticDirectory).toBe("dist");
        expect(plan?.image?.start).toBeNull();
    });

    it("writes no image for a build aimed at another platform", () => {
        // Nothing to run and nothing to serve; an image would build and then do
        // nothing, which is worse than saying what to change.
        const plan = detectBuild(
            alone({ manifest: { scripts: { build: "astro build" }, dependencies: { astro: "7", "@astrojs/vercel": "11" } } })
        );
        expect(plan?.image).toBeNull();
        expect(plan?.note).toContain("@astrojs/node");
    });
});

describe("installing is left alone", () => {
    /**
     * A regression, and an expensive one: detection used to emit the install
     * command too. Writing a phase into nixpacks.toml REPLACES the provider's, and
     * the install phase is where nixpacks bootstraps the package manager itself -
     * so an install command that only restated what nixpacks would have run anyway
     * took the bootstrap out with it, and the build died on "pnpm: command not
     * found" before installing anything.
     *
     * The rule this pins: never override a phase to say what would have happened
     * regardless. A service can still set an install command by hand, which is a
     * deliberate act rather than a restatement.
     */
    it("never emits an install command, whatever it detected", () => {
        const cases = [
            alone({ manifest: { scripts: { build: "next build" }, dependencies: { next: "15" } } }),
            alone({ files: ["package.json", "pnpm-lock.yaml"], manifest: { dependencies: { astro: "5" } } }),
            workspace({ name: "web", scripts: { build: "next build", start: "next start" }, dependencies: { next: "15" } })
        ];
        for (const snapshot of cases) expect(detectBuild(snapshot)?.install ?? null).toBeNull();
    });
});
