import { parse } from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import * as wg from "@/lib/deploy/wireguard/tunnel-config";

/**
 * How the tunnel daemon's image reaches every install. Its containers pull it only
 * when missing, so the name the dashboard renders has to be public, published
 * before the dashboard that names it, never moved to another build, and never
 * pruned while a dashboard still names it. The workflows run only on GitHub; the
 * guards that decide those things are run here with a stubbed registry.
 */

const ROOT = new URL("../../../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");

type Step = { name?: string; id?: string; if?: string; env?: Record<string, string>; run?: string };
type Job = { needs?: string[]; steps: Step[]; outputs?: Record<string, string> };
type Workflow = { jobs: Record<string, Job>; on: { push: { paths: string[] } } };

const publish = parse(read(".github/workflows/dashboard-publish.yml")) as Workflow;
const prune = parse(read(".github/workflows/ghcr-prune.yml")) as Workflow;
const ci = parse(read(".github/workflows/ci.yml")) as Workflow;

function step(job: string, name: string): Step {
    const found = publish.jobs[job].steps.find((each) => each.name === name);
    if (!found) throw new Error(`no step "${name}" in ${job}`);
    return found;
}

/** The CI runners have bash and jq; a machine without them skips the run-throughs. */
const SHELL = spawnSync("bash", ["-c", "command -v jq"], { stdio: "pipe" }).status === 0;

/** Runs a step's script with `docker` stubbed: `inspect` answers `INSPECT_OUT` or
 *  fails with `INSPECT_ERR`, `create` is recorded. */
function runStep(script: string, env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "tunnel-step-"));
    const stub = [
        "docker() {",
        '  case "$3" in',
        '    inspect) [ -n "${INSPECT_ERR:-}" ] && { echo "$INSPECT_ERR" >&2; return 1; }; echo "$INSPECT_OUT";;',
        '    create) echo "create $*" >> "$RUNNER_TEMP/created";;',
        "  esac",
        "}"
    ].join("\n");
    const result = spawnSync("bash", ["-c", `${stub}\ncd "$RUNNER_TEMP"\n${script}`], {
        env: { ...process.env, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, "output"), ...env },
        encoding: "utf8"
    });
    const file = (name: string) => {
        try {
            return readFileSync(join(dir, name), "utf8");
        } catch {
            return "";
        }
    };
    return {
        status: result.status,
        out: result.stdout,
        created: file("created"),
        output: file("output")
    };
}

describe("the tunnel daemon's image", () => {
    const version = /^version = "([^"]+)"$/m.exec(read("crates/polaris-tunnel/Cargo.toml"))?.[1];
    const TAG = "ghcr.io/fjrg2007/polaris-dashboard:latest-service-tunnel-";

    it("is named by the crate's version, as a tag of the dashboard's public package", () => {
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(wg.WIREGUARD_IMAGE).toBe(`${TAG}${version}`);
        // A package of its own would start private, and every pull would be refused.
        expect(read(".github/workflows/dashboard-publish.yml")).not.toContain(
            "fjrg2007/polaris-tunnel"
        );
        expect(publish.on.push.paths).toContain("crates/polaris-tunnel/**");
        expect(step("tunnel-manifest", "Create manifest list").env?.TAG).toBe(
            `${TAG}\${{ needs.changes.outputs.tunnel_version }}`
        );
    });

    it("is never pruned while a dashboard names it, whichever version that is", () => {
        const env = JSON.stringify(prune.jobs.prune.steps);
        expect(env).toMatch(/SERVICE_TAGS":"[^"]*latest-service-tunnel-\*/);
    });

    it("cannot change under a version: a pull request changing its sources raises it", () => {
        expect(ci.jobs["tunnel-version"].steps.at(-1)?.run).toContain(
            ".github/scripts/tunnel-inputs.py"
        );
        expect(publish.jobs.changes.steps.at(-1)?.run).toContain(
            "tunnel_inputs=$(python3 .github/scripts/tunnel-inputs.py HEAD)"
        );
    });

    describe.skipIf(!SHELL && process.env.CI !== "true")("publishing a version", () => {
        const manifest = step("tunnel-manifest", "Create manifest list");
        const env = { TAG: `${TAG}1.2.3`, INPUTS: "abc", PUBLISH: "true" };
        const published = (inputs: string) =>
            JSON.stringify({ annotations: { "dev.polaris.tunnel.inputs": inputs }, manifests: [] });

        it("creates a version not published yet, recording its sources", () => {
            const run = runStep(manifest.run!, {
                ...env,
                INSPECT_ERR: "ERROR: ghcr.io/x: not found"
            });
            expect(run.status).toBe(0);
            expect(run.created).toContain("--annotation index:dev.polaris.tunnel.inputs=abc");
            expect(run.created).toContain(`-t ${TAG}1.2.3`);
        });

        it("leaves a version published from the same sources exactly as it is", () => {
            const run = runStep(manifest.run!, { ...env, INSPECT_OUT: published("abc") });
            expect(run.status).toBe(0);
            expect(run.created).toBe("");
        });

        it("fails, without moving the tag, when the sources changed under a published version", () => {
            for (const recorded of ["other", ""]) {
                const run = runStep(manifest.run!, { ...env, INSPECT_OUT: published(recorded) });
                expect(run.status).toBe(1);
                expect(run.out).toContain("Raise the version in crates/polaris-tunnel/Cargo.toml");
                expect(run.created).toBe("");
            }
        });

        it("creates nothing when the registry cannot be read", () => {
            const run = runStep(manifest.run!, { ...env, INSPECT_ERR: "ERROR: unauthorized" });
            expect(run.status).toBe(1);
            expect(run.created).toBe("");
        });
    });

    describe.skipIf(!SHELL && process.env.CI !== "true")("the dashboard tag waiting for it", () => {
        const check = step("tag", "Check the tunnel daemon the dashboard names");
        const ready = (manifest: string, changed: string, inRegistry = true) =>
            runStep(check.run!, {
                MANIFEST: manifest,
                CHANGED: changed,
                TUNNEL: `${TAG}1.2.3`,
                ...(inRegistry ? { INSPECT_OUT: "{}" } : { INSPECT_ERR: "not found" })
            }).output.trim();

        it("moves only once the version the dashboard names is published", () => {
            expect(ready("success", "true")).toBe("ready=true");
            // Not rebuilt because the daemon did not change: the earlier version stands.
            expect(ready("skipped", "false")).toBe("ready=true");
        });

        it("holds back when the daemon changed and was not published - skipped is not success", () => {
            expect(ready("skipped", "true")).toBe("ready=false");
            expect(ready("failure", "true")).toBe("ready=false");
            expect(ready("cancelled", "false")).toBe("ready=false");
        });

        it("holds back when the version it names is not in the registry", () => {
            expect(ready("skipped", "false", false)).toBe("ready=false");
        });

        it("gates the dashboard, its bundles, and the job's result on that check", () => {
            expect(publish.jobs.tag.needs).toContain("changes");
            expect(step("tag", "Tag the dashboard").if).toContain(
                "steps.tunnel.outputs.ready == 'true'"
            );
            expect(step("tag", "Tag the app bundles").if).toContain(
                "steps.tunnel.outputs.ready == 'true'"
            );
            expect(publish.jobs.tag.steps.at(-1)?.if).toContain(
                "steps.tunnel.outputs.ready == 'false'"
            );
        });
    });
});
