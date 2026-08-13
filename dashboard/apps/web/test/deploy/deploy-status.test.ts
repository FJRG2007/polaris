/**
 * What a service is reported to be doing.
 *
 * The defect this exists for: a project's first service was created, its build
 * started, and every screen said "Not deployed" for as long as the build ran - then
 * went on saying it after the deploy had succeeded, until the page was reloaded by
 * hand. The status was read off the service's current-release pointer, which is only
 * set once a deploy succeeds, so the one state nobody could see was the one that was
 * actually happening.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface DeploymentRow {
    id: string;
    status: string;
    deployableId: string;
}

let rows: DeploymentRow[] = [];

const findMany = vi.fn(async (args: { where: { id?: { in: string[] }; status?: { in: string[] } } }) => {
    if (args.where.id) return rows.filter((row) => args.where.id!.in.includes(row.id));
    const wanted = args.where.status?.in ?? [];
    return rows.filter((row) => wanted.includes(row.status));
});

vi.mock("@polaris/db", () => ({ prisma: { deployment: { findMany } } }));

const { getApplicationDeployStatuses, inFlightDeployments } = await import("@/lib/deploy-service");
const { isInFlightStatus, IN_FLIGHT_DEPLOY_STATUSES, TERMINAL_DEPLOY_STATUSES } = await import("@/lib/deploy/status");

beforeEach(() => {
    rows = [];
    findMany.mockClear();
});

describe("what a service is doing", () => {
    it("says a first build is deploying, though it has no release to point at yet", async () => {
        rows = [{ id: "dep-1", status: "deploying", deployableId: "app-1" }];
        const statuses = await getApplicationDeployStatuses([{ id: "app-1", currentDeploymentId: null }]);
        expect(statuses["app-1"]).toBe("deploying");
    });

    it("reports the build in flight over the release it is replacing", async () => {
        rows = [
            { id: "dep-1", status: "running", deployableId: "app-1" },
            { id: "dep-2", status: "queued", deployableId: "app-1" }
        ];
        const statuses = await getApplicationDeployStatuses([{ id: "app-1", currentDeploymentId: "dep-1" }]);
        expect(statuses["app-1"]).toBe("queued");
    });

    it("reports the serving release once nothing is building", async () => {
        rows = [{ id: "dep-1", status: "running", deployableId: "app-1" }];
        const statuses = await getApplicationDeployStatuses([{ id: "app-1", currentDeploymentId: "dep-1" }]);
        expect(statuses["app-1"]).toBe("running");
    });

    it("leaves out a service that has never been deployed, so the screen can say so", async () => {
        const statuses = await getApplicationDeployStatuses([{ id: "app-1", currentDeploymentId: null }]);
        expect(statuses["app-1"]).toBeUndefined();
    });

    it("asks nothing of the database for an empty list", async () => {
        expect(await getApplicationDeployStatuses([])).toEqual({});
        expect(await inFlightDeployments([])).toEqual(new Map());
        expect(findMany).not.toHaveBeenCalled();
    });
});

describe("still moving", () => {
    it("keeps a screen looking while a build or a database is on its way", () => {
        for (const status of ["queued", "deploying", "provisioning"]) {
            expect(isInFlightStatus(status)).toBe(true);
        }
    });

    it("lets it stop once the state is one a deployment stays in", () => {
        for (const status of TERMINAL_DEPLOY_STATUSES) expect(isInFlightStatus(status)).toBe(false);
        // Unknown and absent alike: a state nobody here recognises must not leave a
        // screen refreshing itself forever.
        expect(isInFlightStatus("something-else")).toBe(false);
        expect(isInFlightStatus(null)).toBe(false);
    });

    it("never calls a state both settled and in flight", () => {
        // The two lists are what the pipeline writes and what the screens watch for.
        // Overlap is the drift that had a service polling with nothing left to learn.
        for (const status of IN_FLIGHT_DEPLOY_STATUSES) expect(TERMINAL_DEPLOY_STATUSES.has(status)).toBe(false);
    });
});
