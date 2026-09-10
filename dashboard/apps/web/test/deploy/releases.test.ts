/**
 * Multi-version releases: what each build runs under, and when a service really
 * runs its versions side by side. The service's own container name and project are
 * protected here - a service that does not keep history must keep exactly the names
 * it already runs under, or the terminal, files and logs would all point at nothing.
 */

import { describe, expect, it, vi } from "vitest";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@polaris/db", () => ({ prisma: { deployment: { findUnique } } }));

const releases = await import("../../src/lib/deploy/releases");
const { keepsReleases, portSubject, releaseMarker, releaseRef, serviceRef } = releases;

const APP = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";
const DEPLOYMENT = "019f9000-1111-7000-8000-222233334444";
const local = { keepReleases: true, volumes: [], target: { kind: "local" } };

describe("releaseMarker", () => {
    it("names a release by its commit, shortened", () => {
        expect(releaseMarker({ id: DEPLOYMENT, commitSha: "9f8e7d6c5b4a3928" })).toBe("9f8e7d6");
    });

    it("falls back to the deployment when there is no commit", () => {
        const marker = releaseMarker({ id: DEPLOYMENT, commitSha: null });
        expect(marker).toMatch(/^[0-9a-f]{7}$/);
        expect(marker).toBe(releaseMarker({ id: DEPLOYMENT }));
    });
});

describe("release naming", () => {
    it("gives each release its own project and container, beside the service's own", () => {
        const base = serviceRef("acme", "invoices", APP);
        const first = releaseRef(base, "9f8e7d6");
        const second = releaseRef(base, "1a2b3c4");
        expect(first.project).not.toBe(base.project);
        expect(first.project).not.toBe(second.project);
        expect(first.name).not.toBe(second.name);
    });

    it("keeps the marker whole when the pair would outgrow a DNS label", () => {
        const base = { name: "a".repeat(63), project: "polaris-abcdef12" };
        const ref = releaseRef(base, "9f8e7d6");
        expect(ref.name).toHaveLength(63);
        expect(ref.name.endsWith("-9f8e7d6")).toBe(true);
    });
});

describe("keepsReleases", () => {
    it("runs versions side by side for a plain service on this host", () => {
        expect(keepsReleases(local)).toBe(true);
    });

    it("does not, when the setting is off", () => {
        expect(keepsReleases({ ...local, keepReleases: false })).toBe(false);
    });

    it("does not, when storage is attached - both versions would hold the same files", () => {
        expect(keepsReleases({ ...local, volumes: [{}] })).toBe(false);
    });

    it("does not, on another server, whose routing rides on the container's own labels", () => {
        expect(keepsReleases({ ...local, target: { kind: "host" } })).toBe(false);
    });
});

describe("portSubject", () => {
    it("follows a release that runs in a project of its own", () => {
        expect(portSubject(APP, { id: DEPLOYMENT, isolated: true })).toBe(DEPLOYMENT);
    });

    it("stays on the service itself otherwise, so an existing service keeps its port", () => {
        expect(portSubject(APP, { id: DEPLOYMENT, isolated: false })).toBe(APP);
        expect(portSubject(APP, null)).toBe(APP);
    });

    it("does not move a running version when the setting is turned off under it", () => {
        // The flag is recorded on the deployment, so what serves the address now is
        // unaffected by a later change to whether NEW releases are kept apart.
        expect(portSubject(APP, { id: DEPLOYMENT, isolated: true })).toBe(DEPLOYMENT);
    });
});

describe("runsCutover", () => {
    const plain = {
        keepReleases: false,
        publishPort: false,
        replicas: 1,
        sourceType: "github",
        sourceConfig: "{}",
        volumes: [],
        target: { kind: "local", runtime: "compose" }
    };
    /** This host's edge, or another server's prepared to take pushed routes. */
    const routed = { followsPushedRoutes: true };

    it("changes over beside the running release for a private service on this host", () => {
        expect(releases.runsCutover(plain, routed)).toBe(true);
    });

    it("changes over with several copies too: each new copy answers to its copy name", () => {
        expect(releases.runsCutover({ ...plain, replicas: 2 }, routed)).toBe(true);
        expect(releases.runsCutover({ ...plain, replicas: 10 }, routed)).toBe(true);
    });

    it("changes over on another server whose edge dials the service from pushed routes", () => {
        const remote = { ...plain, target: { kind: "host", runtime: "compose" } };
        expect(releases.runsCutover(remote, routed)).toBe(true);
        expect(releases.runsCutover({ ...remote, replicas: 3 }, routed)).toBe(true);
    });

    it("does not on a server whose edge reads only the labels, where both releases claim the address", () => {
        const remote = { ...plain, target: { kind: "host", runtime: "compose" } };
        expect(releases.runsCutover(remote, { followsPushedRoutes: false })).toBe(false);
        expect(
            releases.runsCutover({ ...remote, replicas: 3 }, { followsPushedRoutes: false })
        ).toBe(false);
    });

    it("does not where two copies would collide or the names are not ours", () => {
        // A published port, a volume or a second port on the host would be fought
        // over; a compose file of the owner's own names itself.
        expect(releases.runsCutover({ ...plain, publishPort: true }, routed)).toBe(false);
        expect(releases.runsCutover({ ...plain, publishPort: true, replicas: 3 }, routed)).toBe(
            false
        );
        expect(releases.runsCutover({ ...plain, volumes: [{}] }, routed)).toBe(false);
        expect(
            releases.runsCutover(
                { ...plain, sourceConfig: '{"extraPorts":[{"host":1,"container":1}]}' },
                routed
            )
        ).toBe(false);
        expect(releases.runsCutover({ ...plain, sourceType: "compose" }, routed)).toBe(false);
        expect(releases.runsCutover({ ...plain, sourceConfig: "not json" }, routed)).toBe(false);
    });

    it("does not on swarm, which replaces start-first on its own", () => {
        expect(
            releases.runsCutover({ ...plain, target: { kind: "local", runtime: "swarm" } }, routed)
        ).toBe(false);
        expect(
            releases.runsCutover({ ...plain, target: { kind: "host", runtime: "swarm" } }, routed)
        ).toBe(false);
    });

    it("leaves a service that keeps its releases to that", () => {
        expect(releases.runsCutover({ ...plain, keepReleases: true }, routed)).toBe(false);
    });
});

describe("markerOf", () => {
    it("names a change-over release after the deployment, so one commit redeployed is a new container", () => {
        const commit = "9f8e7d6c5b4a3928";
        expect(releases.markerOf({ id: DEPLOYMENT, commitSha: commit, cutover: true })).toBe(
            releaseMarker({ id: DEPLOYMENT })
        );
        expect(releases.markerOf({ id: DEPLOYMENT, commitSha: commit })).toBe("9f8e7d6");
    });
});

describe("currentReleaseRef", () => {
    const app = {
        id: APP,
        slug: "invoices",
        currentDeploymentId: DEPLOYMENT,
        environment: { project: { slug: "acme" } }
    };
    const base = serviceRef("acme", "invoices", APP);

    it("reaches a change-over release in its own container, and by the service's own name", async () => {
        findUnique.mockResolvedValueOnce({
            id: DEPLOYMENT,
            commitSha: "9f8e7d6c5b4a3928",
            isolated: true,
            cutover: true
        });
        const serving = await releases.currentReleaseRef(app);
        expect(serving.name).toBe(releaseRef(base, releaseMarker({ id: DEPLOYMENT })).name);
        expect(serving.address).toBe(base.name);
        expect(serving.portSubject).toBe(APP);
    });

    it("reaches a kept release by its own name and port", async () => {
        findUnique.mockResolvedValueOnce({
            id: DEPLOYMENT,
            commitSha: "9f8e7d6c5b4a3928",
            isolated: true,
            cutover: false
        });
        const serving = await releases.currentReleaseRef(app);
        expect(serving.address).toBe(serving.name);
        expect(serving.portSubject).toBe(DEPLOYMENT);
    });

    it("keeps the service's own names for a release deployed in place", async () => {
        findUnique.mockResolvedValueOnce({
            id: DEPLOYMENT,
            commitSha: null,
            isolated: false,
            cutover: false
        });
        expect(await releases.currentReleaseRef(app)).toEqual({
            ...base,
            portSubject: APP,
            address: base.name
        });
    });
});
