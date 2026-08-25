/**
 * Reading a compose project back to the thing it was started for, and adding the
 * machine up from there.
 *
 * The trap: everything Polaris runs is started with compose under a project that
 * begins `polaris-`, and so is Polaris. Anything matching on that prefix would put
 * a game server's memory on the control plane's row; anything matching too
 * narrowly would drop a service's kept release, or the tunnel publishing it, into
 * "everything else" - and both readings look plausible on the screen.
 */

import { shortHash } from "@polaris/deploy";
import { describe, expect, it } from "vitest";
import { attribute, projectSubject, subjectHash, type Attributable, type Claim, type ClaimIndex } from "@/lib/consumption";

const APP = "0198f4c1-2b7a-7000-8000-000000000001";
const OTHER_APP = "0198f4c1-2b7a-7000-8000-000000000002";
const DB = "0198f4c1-2b7a-7000-8000-000000000003";

describe("what a compose project belongs to", () => {
    it("reads a service's own project", () => {
        expect(projectSubject(`polaris-${subjectHash(APP)}`)).toEqual({
            kind: "application",
            hash: subjectHash(APP),
            role: "self"
        });
    });

    it("keeps a kept release with the service it is a release of", () => {
        expect(projectSubject(`polaris-${subjectHash(APP)}-a1b2c3d`)).toEqual({
            kind: "application",
            hash: subjectHash(APP),
            role: "self"
        });
    });

    it("attributes every kind of tunnel to the service it publishes", () => {
        for (const prefix of ["qtunnel", "ntunnel", "ngrok"]) {
            expect(projectSubject(`polaris-${prefix}-${subjectHash(APP)}`)).toEqual({
                kind: "application",
                hash: subjectHash(APP),
                role: "tunnel"
            });
        }
    });

    it("tells a managed database from a service, which its hash alone would not", () => {
        expect(projectSubject(`polaris-db-${subjectHash(DB)}`)).toEqual({
            kind: "database",
            hash: subjectHash(DB),
            role: "self"
        });
    });

    it("claims nothing for the stack itself, or for a container nobody started with compose", () => {
        expect(projectSubject("polaris")).toBeNull();
        expect(projectSubject("polaris-tunnel")).toBeNull();
        expect(projectSubject("polaris-ptunnel")).toBeNull();
        expect(projectSubject(null)).toBeNull();
    });

    it("claims nothing for a project that only looks like one of ours", () => {
        expect(projectSubject("polaris-marketplace")).toBeNull();
        expect(projectSubject("not-polaris-1234abcd")).toBeNull();
    });

    it("reads the hash at the width every writer uses", () => {
        // The pipeline, the three tunnel services and the database provisioner all
        // build their project from an 8-character hash. Reading it at any other
        // width matches nothing and says nothing about it.
        expect(subjectHash(APP)).toBe(shortHash(APP, 8));
        expect(subjectHash(APP)).toHaveLength(8);
    });
});

function container(overrides: Partial<Attributable> & { name: string }): Attributable {
    return {
        id: overrides.name,
        image: "image:latest",
        state: "running",
        composeProject: null,
        composeService: null,
        cpuPercent: null,
        memUsedBytes: null,
        ...overrides
    };
}

function claim(key: string, bucket: Partial<Claim["bucket"]> & { group: Claim["bucket"]["group"] }): Claim {
    return {
        key,
        bucket: {
            id: key,
            name: key,
            detail: "",
            owner: null,
            href: null,
            ...bucket
        }
    };
}

function index(overrides: Partial<Record<keyof ClaimIndex, Map<string, Claim>>> = {}): ClaimIndex {
    return {
        applications: overrides.applications ?? new Map(),
        databases: overrides.databases ?? new Map(),
        installs: overrides.installs ?? new Map()
    };
}

function group(groups: ReturnType<typeof attribute>, id: string) {
    const found = groups.find((entry) => entry.id === id);
    if (!found) throw new Error(`no ${id} group`);
    return found;
}

describe("adding the machine up", () => {
    const install = claim("install:1", { group: "apps", id: "1", name: "Survival" });
    const service = claim("service:2", { group: "services", id: "2", name: "api" });
    const database = claim("database:3", { group: "services", id: "3", name: "main" });
    const full = index({
        applications: new Map([
            [subjectHash(APP), install],
            [subjectHash(OTHER_APP), service]
        ]),
        databases: new Map([[subjectHash(DB), database]]),
        installs: new Map([[install.key, install]])
    });

    it("keeps the stack's own containers out of everything it runs", () => {
        const groups = attribute(
            [
                container({ name: "polaris-web-181", composeProject: "polaris", composeService: "web", memUsedBytes: 900 }),
                container({ name: "ptunnel", composeProject: "polaris-ptunnel", composeService: "ptunnel", memUsedBytes: 100 }),
                container({ name: "survival", composeProject: `polaris-${subjectHash(APP)}`, memUsedBytes: 4000 })
            ],
            full,
            "local"
        );
        expect(group(groups, "polaris").memUsedBytes).toBe(1000);
        expect(group(groups, "polaris").containers).toBe(2);
        // The stack is one total here; its parts are a table on their own endpoint.
        expect(group(groups, "polaris").rows).toHaveLength(0);
        expect(group(groups, "apps").memUsedBytes).toBe(4000);
    });

    it("counts a service's releases and its tunnel as one service", () => {
        const groups = attribute(
            [
                container({ name: "api", composeProject: `polaris-${subjectHash(OTHER_APP)}`, memUsedBytes: 300 }),
                container({ name: "api-a1b2c3d", composeProject: `polaris-${subjectHash(OTHER_APP)}-a1b2c3d`, memUsedBytes: 200 }),
                container({ name: "qtunnel", composeProject: `polaris-qtunnel-${subjectHash(OTHER_APP)}`, memUsedBytes: 50 })
            ],
            full,
            "local"
        );
        const rows = group(groups, "services").rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: "2", containers: 3, memUsedBytes: 550, state: "running" });
    });

    it("does not let a tunnel that is up say the app behind it is running", () => {
        const groups = attribute(
            [
                container({ name: "api", composeProject: `polaris-${subjectHash(OTHER_APP)}`, state: "exited" }),
                container({ name: "qtunnel", composeProject: `polaris-qtunnel-${subjectHash(OTHER_APP)}` })
            ],
            full,
            "local"
        );
        expect(group(groups, "services").rows[0]).toMatchObject({ state: "stopped", stateLabel: "Stopped" });
        expect(group(groups, "services").running).toBe(0);
    });

    it("reads a marketplace app as the app, not as the service it runs under", () => {
        const groups = attribute(
            [container({ name: "survival", composeProject: `polaris-${subjectHash(APP)}`, memUsedBytes: 4000 })],
            full,
            "local"
        );
        expect(group(groups, "apps").rows[0]).toMatchObject({ id: "1", name: "Survival", href: null });
        expect(group(groups, "services").rows).toHaveLength(0);
    });

    it("still gives a row to an install whose containers are on another server", () => {
        const groups = attribute([], full, "local");
        expect(group(groups, "apps").rows).toEqual([
            expect.objectContaining({ id: "1", state: "elsewhere", containers: 0, memUsedBytes: null })
        ]);
    });

    it("gathers a managed database with the services rather than with the strangers", () => {
        const groups = attribute(
            [container({ name: "pg", composeProject: `polaris-db-${subjectHash(DB)}`, memUsedBytes: 700 })],
            full,
            "local"
        );
        expect(group(groups, "services").rows[0]).toMatchObject({ id: "3", memUsedBytes: 700 });
        expect(group(groups, "other").rows).toHaveLength(0);
    });

    it("leaves a container nothing here claims as itself, linked to its own page", () => {
        const groups = attribute(
            [
                container({ name: "someone-elses", composeProject: "their-stack", memUsedBytes: 20 }),
                // A project shaped like ours whose hash resolves to nothing is not
                // ours: a record has to exist for it to be claimed.
                container({ name: "lookalike", composeProject: "polaris-deadbeef", memUsedBytes: 10 })
            ],
            full,
            "local"
        );
        const rows = group(groups, "other").rows;
        expect(rows.map((row) => row.name)).toEqual(["someone-elses", "lookalike"]);
        expect(rows[0]?.href).toBe("/apps/containers/someone-elses?c=local");
    });

    it("leaves an unsampled container without a figure rather than at zero", () => {
        const groups = attribute([container({ name: "fresh", composeProject: "their-stack" })], full, "local");
        expect(group(groups, "other").rows[0]).toMatchObject({ cpuPercent: null, memUsedBytes: null });
        expect(group(groups, "other").memUsedBytes).toBe(0);
    });

    it("puts the heaviest row first, which is the one being looked for", () => {
        const groups = attribute(
            [
                container({ name: "small", composeProject: "a", memUsedBytes: 10 }),
                container({ name: "big", composeProject: "b", memUsedBytes: 900 }),
                container({ name: "middle", composeProject: "c", memUsedBytes: 100 })
            ],
            index(),
            "local"
        );
        expect(group(groups, "other").rows.map((row) => row.name)).toEqual(["big", "middle", "small"]);
    });
});
