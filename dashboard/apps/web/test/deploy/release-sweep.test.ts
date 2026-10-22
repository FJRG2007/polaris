/**
 * The release a redeploy replaced is taken down whatever project it was created
 * under. Pinned on the case seen on a real host: the service's previous release
 * ran in its own `polaris-<hash>` project (the naming from before releases had
 * projects of their own), the change-over release came up in
 * `polaris-<hash>-<marker>`, the row was marked removed and the old container
 * kept serving. Also pins what the periodic sweep is allowed to judge.
 */

import { describe, expect, it, vi } from "vitest";

const { applicationFindMany, deploymentFindMany, deploymentFindUnique, getPorts, releaseBusy } =
    vi.hoisted(() => ({
        applicationFindMany: vi.fn(),
        deploymentFindMany: vi.fn(),
        deploymentFindUnique: vi.fn(),
        getPorts: vi.fn(),
        releaseBusy: vi.fn()
    }));
vi.mock("@polaris/db", () => ({
    prisma: {
        application: { findMany: applicationFindMany },
        deployment: { findMany: deploymentFindMany, findUnique: deploymentFindUnique }
    }
}));
// The engine's pure parts, from source, so the test reads the code under change.
vi.mock("@polaris/deploy", async () => import("../../../../packages/deploy/src/index"));
vi.mock("../../src/lib/deploy/runtime", () => ({ getPorts }));
vi.mock("../../src/lib/deploy-service", () => ({ releaseBusy }));

const { downSupersededReleases, keptProjects, sweepOrphanReleases, sweepServices } =
    await import("../../src/lib/deploy/release-sweep");
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
            releaseContainers: vi
                .fn()
                .mockResolvedValue([
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
        const services = sweepServices([app], serving, [
            row(NEW, { isolated: true, cutover: true })
        ]);
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

describe("the hourly sweep", () => {
    const BUSY = "019f8506-0000-7000-8000-aaaabbbbcccc";
    const OTHER = "019f8506-1111-7000-8000-aaaabbbbcccc";
    const target = (id: string) => ({
        id,
        kind: "ssh",
        hostId: null,
        runtime: "compose",
        proxyNetwork: null
    });
    const owned = (id: string, slug: string, targetId: string) => ({
        id,
        slug,
        currentDeploymentId: `${id}-current`,
        environment: { project: { slug, ownerId: "owner" } },
        target: target(targetId)
    });
    const busyBase = serviceRef("busy", "busy", BUSY);

    it("removes only an old release no settled service runs, and skips a machine it cannot list", async () => {
        const now = Date.now();
        deploymentFindMany.mockReset();
        applicationFindMany.mockResolvedValue([
            {
                ...app,
                environment: { project: { slug: "hmars", ownerId: "owner" } },
                target: target("t1")
            },
            owned(BUSY, "busy", "t1"),
            owned(OTHER, "other", "t2")
        ]);
        releaseBusy.mockImplementation((id: string) => id === BUSY);
        deploymentFindMany.mockImplementation(async (args: { where: { status?: unknown } }) =>
            args.where.status
                ? [
                      row(NEW, { isolated: true, cutover: true }),
                      { ...row("x", {}), deployableId: OTHER }
                  ]
                : [
                      { id: NEW, commitSha: "ba791a7aaaaaaa", isolated: true, cutover: true },
                      { id: `${BUSY}-current`, commitSha: null, isolated: false, cutover: false },
                      { id: `${OTHER}-current`, commitSha: null, isolated: false, cutover: false }
                  ]
        );
        const removeContainer = vi.fn().mockResolvedValue(undefined);
        const fresh = {
            ...containerIn(base.project, `${base.name}-fresh`, "eeeeeeeeeeee"),
            createdAt: now
        };
        const listed = {
            releaseContainers: vi
                .fn()
                .mockResolvedValue([
                    containerIn(base.project, base.name, "aaaaaaaaaaaa"),
                    containerIn(cutover.project, cutover.name, "bbbbbbbbbbbb"),
                    fresh,
                    containerIn(`${busyBase.project}-old1`, busyBase.name, "cccccccccccc"),
                    containerIn("polaris-3f0d2a11", "portfolio", "dddddddddddd")
                ]),
            removeContainer,
            stackDown: vi.fn(),
            dispose: vi.fn().mockResolvedValue(undefined)
        };
        const unlisted = {
            releaseContainers: vi.fn().mockRejectedValue(new Error("unreachable")),
            removeContainer: vi.fn(),
            stackDown: vi.fn(),
            dispose: vi.fn().mockResolvedValue(undefined)
        };
        getPorts.mockImplementation(async (row: { id: string }) =>
            row.id === "t1" ? listed : unlisted
        );
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        const swept = await sweepOrphanReleases(now);

        expect(removeContainer.mock.calls).toEqual([["aaaaaaaaaaaa"]]);
        expect(unlisted.removeContainer).not.toHaveBeenCalled();
        expect(swept).toEqual([
            { targetId: "t1", removed: [{ name: base.name, project: base.project }] }
        ]);
        expect(listed.dispose).toHaveBeenCalled();
        expect(unlisted.dispose).toHaveBeenCalled();
        const kept = deploymentFindMany.mock.calls
            .map(([args]) => args.where)
            .filter((where: { status?: unknown }) => where.status);
        expect(kept.map((where: { deployableId: unknown }) => where.deployableId)).toEqual([
            { in: [APP, BUSY] }
        ]);
        expect(kept[0].status.in).toContain("running");
    });
});
