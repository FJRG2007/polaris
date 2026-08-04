/**
 * The promise this detection has to keep: it may only ever make a deploy MORE
 * likely to work.
 *
 * Everything here writes into a nixpacks.toml, and a phase written there replaces
 * the builder's own. That is a loaded gun pointed at every stack Polaris does not
 * specifically know about - and two shots have already been fired. Restating the
 * install command took the package-manager bootstrap out with it; naming a Node
 * major the builder did not carry fell back to its default and downgraded the
 * runtime. Both looked harmless in review.
 *
 * So this sweeps the stacks people actually deploy and pins the invariant rather
 * than the output: for anything that is not a JavaScript workspace or a framework
 * whose start is otherwise unknowable, Polaris says NOTHING and the builder is
 * left exactly as it was.
 */

import { describe, expect, it } from "vitest";
import { detectBuild, nixpacksConfig, type RepoSnapshot } from "../src/index.js";

/** A repository root holding these files and, optionally, this manifest. */
function repo(files: string[], manifest?: RepoSnapshot["levels"][number]["manifest"]): RepoSnapshot {
    return { levels: [{ path: "", files, manifest }] };
}

/** What would actually be written into the build context. */
function written(snapshot: RepoSnapshot): string | null {
    const plan = detectBuild(snapshot);
    return nixpacksConfig({
        packages: plan?.packages,
        install: plan?.install,
        build: plan?.build,
        start: plan?.start
    });
}

describe("stacks Polaris does not claim to know", () => {
    const others: Array<[string, RepoSnapshot]> = [
        ["Python (pip)", repo(["requirements.txt", "main.py"])],
        ["Python (poetry)", repo(["pyproject.toml", "poetry.lock"])],
        ["Go", repo(["go.mod", "go.sum", "main.go"])],
        ["Rust", repo(["Cargo.toml", "Cargo.lock", "src"])],
        ["Ruby", repo(["Gemfile", "Gemfile.lock", "config.ru"])],
        ["PHP", repo(["composer.json", "composer.lock", "index.php"])],
        ["Java", repo(["pom.xml", "src"])],
        ["Elixir", repo(["mix.exs", "mix.lock"])],
        ["Deno", repo(["deno.json", "main.ts"])],
        ["static HTML", repo(["index.html", "style.css"])],
        ["a repository with nothing in it", repo([])]
    ];

    it.each(others)("writes nothing for %s", (_label, snapshot) => {
        expect(detectBuild(snapshot)).toBeNull();
        expect(written(snapshot)).toBeNull();
    });
});

describe("JavaScript projects the builder already handles", () => {
    /** A single-package repository with these dependencies and scripts. */
    const app = (dependencies: Record<string, string>, scripts: Record<string, string>, lock = "package-lock.json") =>
        repo(["package.json", lock], { dependencies, scripts });

    it.each([
        ["Express with a start script", { express: "4" }, { start: "node server.js" }],
        ["Fastify with a start script", { fastify: "5" }, { start: "node app.js" }],
        ["Next with a start script", { next: "15" }, { build: "next build", start: "next start" }],
        ["Nuxt with a start script", { nuxt: "3" }, { build: "nuxt build", start: "nuxt start" }],
        ["a plain script", {}, { start: "node index.js" }],
        ["bun", { hono: "4" }, { start: "bun run index.ts" }]
    ])("leaves %s completely alone", (_label, dependencies, scripts) => {
        expect(written(app(dependencies, scripts))).toBeNull();
    });

    it("leaves a project with no scripts at all to the builder", () => {
        expect(written(app({ express: "4" }, {}))).toBeNull();
    });
});

describe("what it does write is only ever additive", () => {
    it("never writes an install phase, for any input", () => {
        const inputs = [
            repo(["package.json", "pnpm-lock.yaml"], { dependencies: { next: "15" }, scripts: { build: "next build" } }),
            repo(["package.json", "yarn.lock"], { dependencies: { astro: "5" }, scripts: { build: "astro build" } }),
            {
                levels: [
                    { path: "", files: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"], manifest: { workspaces: ["*"] } },
                    { path: "web", files: ["package.json"], manifest: { name: "web", scripts: { build: "vite build", start: "node ." } } }
                ]
            } satisfies RepoSnapshot
        ];
        for (const snapshot of inputs) expect(written(snapshot) ?? "").not.toContain("[phases.install]");
    });

    it("extends the setup packages rather than replacing them", () => {
        // A bare nixPkgs list drops the language runtime; the image would hold a
        // file server and no Node.
        const astro = repo(["package.json"], { dependencies: { astro: "5" }, scripts: { build: "astro build" } });
        const config = written(astro) ?? "";
        expect(config).toContain("[phases.setup]");
        expect(config).toContain('nixPkgs = ["...", "caddy"]');
    });

    it("only overrides the build phase when it genuinely has to differ", () => {
        // Outside a workspace the command is what the builder would have run.
        const plain = repo(["package.json"], { dependencies: { next: "15" }, scripts: { build: "next build" } });
        expect(written(plain) ?? "").not.toContain("[phases.build]");

        const workspace: RepoSnapshot = {
            levels: [
                { path: "", files: ["package.json", "pnpm-lock.yaml"], manifest: { workspaces: ["*"] } },
                { path: "web", files: ["package.json"], manifest: { name: "web", scripts: { build: "next build" }, dependencies: { next: "15" } } }
            ]
        };
        expect(written(workspace) ?? "").toContain("[phases.build]");
    });
});

describe("a version nobody here has seen", () => {
    it("does not care which major of a framework it is", () => {
        // The tables key on the dependency name, never on its version, so a major
        // released after this was written behaves the same.
        for (const version of ["12", "15.0.0-canary.1", "^99", "workspace:*", "latest"]) {
            const plan = detectBuild(repo(["package.json"], { dependencies: { next: version }, scripts: { build: "next build" } }));
            expect(plan?.framework, version).toBe("Next.js");
            expect(plan?.start, version).toBe("next start");
        }
    });

    it("survives a manifest that is not shaped the way it expects", () => {
        const odd = {
            levels: [
                {
                    path: "",
                    files: ["package.json"],
                    // Everything the wrong type, as a hand-edited manifest can be.
                    manifest: { dependencies: null, scripts: null, workspaces: null, engines: null } as never
                }
            ]
        } satisfies RepoSnapshot;
        expect(() => detectBuild(odd)).not.toThrow();
    });
});
