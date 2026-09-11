/**
 * A service somebody stopped, and the machine that kept running it.
 *
 * Stopping is two things that can come apart: the record says
 * `desiredState: "stopped"`, and the container is halted. The record is written
 * first on purpose - a stop that half-succeeded must not leave the app claiming
 * it should be up - so the half that fails is the container, and nothing ever
 * went back for it. Every screen said stopped. `docker ps` said otherwise.
 *
 * It happened: a service migrated to Vercel was stopped in the same breath as a
 * deploy of it was finishing, the stop failed against a container that was being
 * replaced that second, and the replacement served - and held its memory - for
 * two days on a project whose owner had been told it had moved.
 *
 * This pass is the thing that goes back for it.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

const sweep = await readFile(`${SRC}lib/deploy/desired-state.ts`, "utf8");

describe("what the pass looks at", () => {
    it("is every service believed to be stopped that has been deployed", async () => {
        expect(sweep).toContain('desiredState: "stopped"');
        // Never released here is nothing to find, and asking is a round trip for
        // an answer that is known.
        expect(sweep).toContain("currentDeploymentId: { not: null }");
    });

    it("asks the machine under the project the service actually runs as", async () => {
        expect(sweep).toContain(
            "const { project } = serviceRef(app.environment.project.slug, app.slug, app.id);"
        );
        expect(sweep).toContain("ports.listContainers(project)");
    });

    it("costs one connection per machine rather than one per service", async () => {
        expect(sweep).toContain("const byTarget = new Map<string, Deployed[]>();");
        expect(sweep).toContain("await ports.dispose()");
    });
});

describe("what it does about it", () => {
    it("stops what is up and starts nothing", async () => {
        expect(sweep).toContain('.container(name, "stop")');
        expect(sweep).not.toContain('"start"');
        // Removing is somebody's decision, made on a screen - see
        // `host-containers`. Nothing here calls for one.
        expect(sweep).not.toMatch(/removeContainer|composeDown|\.remove\(/);
    });

    it("counts a machine that would not answer rather than assuming it was right", async () => {
        expect(sweep).toContain("unreachable += group.length;");
        expect(sweep).toContain("if (running === null) {");
    });

    it("lets one refusal stand without dropping the rest", async () => {
        expect(sweep).toContain(".catch(() => false)");
    });
});

describe("when it runs", () => {
    it("is scheduled, and leased so two processes never stop the same container", async () => {
        const jobs = await readFile(`${SRC}lib/cron/jobs.ts`, "utf8");
        const job = jobs.slice(jobs.indexOf('key: "service-desired-state"'));
        const body = job.slice(0, job.indexOf("},"));
        expect(body).toContain("everyMs: 5 * MINUTE");
        expect(body).toContain("leaseMs: 10 * MINUTE");
        expect(jobs).toContain("run: () => runDesiredStatePass()");
    });
});
