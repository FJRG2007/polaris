/**
 * Multi-version releases: what each build runs under, and when a service really
 * runs its versions side by side. The service's own container name and project are
 * protected here - a service that does not keep history must keep exactly the names
 * it already runs under, or the terminal, files and logs would all point at nothing.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: { deployment: { findUnique: vi.fn() } } }));

const { keepsReleases, portSubject, releaseMarker, releaseRef, serviceRef } = await import(
    "../../src/lib/deploy/releases"
);

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
