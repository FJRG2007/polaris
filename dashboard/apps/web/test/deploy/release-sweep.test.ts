/**
 * The release a redeploy replaced is taken down whatever project it was created
 * under. Pinned on the case seen on a real host: the service's previous release
 * ran in its own `polaris-<hash>` project (the naming from before releases had
 * projects of their own), the change-over release came up in
 * `polaris-<hash>-<marker>`, the row was marked removed and the old container
 * kept serving. Also pins what the periodic sweep is allowed to judge.
 */

import { describe, expect, it, vi } from "vitest";

const { deploymentFindMany, deploymentFindUnique } = vi.hoisted(() => ({
    deploymentFindMany: vi.fn(),
    deploymentFindUnique: vi.fn()
}));
vi.mock("@polaris/db", () => ({
    prisma: { deployment: { findMany: deploymentFindMany, findUnique: deploymentFindUnique } }
}));
// The engine's pure parts, from source, so the test reads the code under change.
vi.mock("@polaris/deploy", async () => import("../../../../packages/deploy/src/index"));
vi.mock("../../src/lib/deploy/runtime", () => ({ getPorts: vi.fn() }));

const { downSupersededReleases, keptProjects, sweepServices } = await import(
    "../../src/lib/deploy/release-sweep"
);
const { releaseRef, serviceRef, markerOf } = await import("../../src/lib/deploy/releases");

const APP = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";
const NEW = "019f9000-1111-7000-8000-222233334444";
const OLD = "019e0000-1111-7000-8000-222233334444";
const app = {
    id: APP,
    slug: "hmars",
    currentDeploymentId: NEW,
    environment: { project: { slug: "hmars" } }
};
const base = serviceRef("hmars", "hmars", APP);
const cutover = releaseRef(base, markerOf({ id: NEW, cutover: true }));

function row(id: string, extra: Partial<{ status: string; isolated: boolean; cutover: boolean }>) {
    return {
        id,
        deployableId: APP,
        status: "running",
        commitSha: "ba791a7aaaaaaa",
        isolated: false,
        cutover: false,
        ...extra
    };
}

function containerIn(project: string, name: string, id: string) {
    return {
        id,
        name,
        project,
        engine: "compose" as const,
        running: true,
        createdAt: Date.now() - 60 * 60 * 1000
    };
}

describe("the projects a service keeps", () => {
    it("is the one serving plus every release still running", () => {
        const kept = releaseRef(base, markerOf({ id: OLD, commitSha: "1234567aaa" }));
        const keep = keptProjects(base, cutover.project, [
            row(NEW, { isolated: true, cutover: true }),
            { ...row(OLD, { isolated: true }), commitSha: "1234567aaa" }
        ]);
        expect([...keep].sort()).toEqual([cutover.project, kept.project].sort());
    });

    it("keeps both shapes a deploy in flight could still run under", () => {
        const keep = keptProjects(base, cutover.project, [row(OLD, { status: "deploying" })]);
        expect(keep.has(base.project)).toBe(true);
        expect(keep.has(cutover.project)).toBe(true);
    });
});

describe("after a promotion", () => {
    it("removes the previous release left in the service's own project", async () => {
        deploymentFindUnique.mockResolvedValue({
            id: NEW,
            commitSha: "ba791a7aaaaaaa",
            isolated: true,
            cutover: true
        });
        // The previous row is being retired, so it is not among the kept ones.
        deploymentFindMany.mockResolvedValue([row(NEW, { isolated: true, cutover: true })]);
        const removeContainer = vi.fn().mockResolvedValue(undefined);
        const ports = {
            releaseContainers: vi.fn().mockResolvedValue([
                containerIn(base.project, base.name, "aaaaaaaaaaaa"),
                containerIn(cutover.project, cutover.name, "bbbbbbbbbbbb"),
                containerIn(cutover.project, `${cutover.name}-p80`, "cccccccccccc"),
                containerIn("polaris-3f0d2a11", "portfolio", "dddddddddddd")
            ]),
            removeContainer,
            stackDown: vi.fn()
        };
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        const removed = await downSupersededReleases(app, ports as never, [OLD]);

        expect(removeContainer.mock.calls).toEqual([["aaaaaaaaaaaa"]]);
        expect(removed).toEqual([{ name: base.name, project: base.project }]);
        expect(deploymentFindMany.mock.calls[0]?.[0]?.where?.id).toEqual({ notIn: [OLD] });
    });

    it("removes nothing on a machine that cannot list its containers", async () => {
        const ports = { stackDown: vi.fn() };
        expect(await downSupersededReleases(app, ports as never, [OLD])).toEqual([]);
    });
});

describe("what the sweep may judge", () => {
    const serving = new Map([[APP, { ...cutover, portSubject: APP, address: base.name }]]);

    it("maps a settled service to the projects it keeps", () => {
        const services = sweepServices([app], serving, [row(NEW, { isolated: true, cutover: true })]);
        expect([...services.keys()]).toEqual([base.project]);
        expect([...(services.get(base.project) ?? [])]).toEqual([cutover.project]);
    });

    it("leaves out a service mid-deploy, mid-promotion, or with no current release", () => {
        expect(
            sweepServices([app], serving, [
                row(NEW, { isolated: true, cutover: true }),
                row(OLD, { status: "queued" })
            ]).size
        ).toBe(0);
        expect(sweepServices([{ ...app, busy: true }], serving, []).size).toBe(0);
        expect(sweepServices([{ ...app, currentDeploymentId: null }], serving, []).size).toBe(0);
    });
});
