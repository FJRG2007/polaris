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
import {
    attribute,
    projectSubject,
    subjectHash,
    type Attributable,
    type Claim,
    type ClaimIndex
} from "@/lib/consumption";

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

function claim(
    key: string,
    bucket: Partial<Claim["bucket"]> & { group: Claim["bucket"]["group"] },
    part?: Partial<Claim["bucket"]> & { id: string }
): Claim {
    const shape = (over: Partial<Claim["bucket"]>): Claim["bucket"] => ({
        id: key,
        name: key,
        detail: "",
        owner: null,
        href: null,
        group: bucket.group,
        ...over
    });
    return { key, bucket: shape(bucket), ...(part ? { part: shape(part) } : {}) };
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
                container({
                    name: "polaris-web-181",
                    composeProject: "polaris",
                    composeService: "web",
                    memUsedBytes: 900
                }),
                container({
                    name: "ptunnel",
                    composeProject: "polaris-ptunnel",
                    composeService: "ptunnel",
                    memUsedBytes: 100
                }),
                container({
                    name: "survival",
                    composeProject: `polaris-${subjectHash(APP)}`,
                    memUsedBytes: 4000
                })
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
                container({
                    name: "api",
                    composeProject: `polaris-${subjectHash(OTHER_APP)}`,
                    memUsedBytes: 300
                }),
                container({
                    name: "api-a1b2c3d",
                    composeProject: `polaris-${subjectHash(OTHER_APP)}-a1b2c3d`,
                    memUsedBytes: 200
                }),
                container({
                    name: "qtunnel",
                    composeProject: `polaris-qtunnel-${subjectHash(OTHER_APP)}`,
                    memUsedBytes: 50
                })
            ],
            full,
            "local"
        );
        const rows = group(groups, "services").rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            id: "2",
            containers: 3,
            memUsedBytes: 550,
            state: "running"
        });
    });

    it("does not let a tunnel that is up say the app behind it is running", () => {
        const groups = attribute(
            [
                container({
                    name: "api",
                    composeProject: `polaris-${subjectHash(OTHER_APP)}`,
                    state: "exited"
                }),
                container({
                    name: "qtunnel",
                    composeProject: `polaris-qtunnel-${subjectHash(OTHER_APP)}`
                })
            ],
            full,
            "local"
        );
        expect(group(groups, "services").rows[0]).toMatchObject({
            state: "stopped",
            stateLabel: "Stopped"
        });
        // The group counts containers, and the tunnel is one that is up.
        expect(group(groups, "services").containers).toBe(2);
        expect(group(groups, "services").running).toBe(1);
    });

    it("reads a tunnel whose service is gone as what it is: a container that is up", () => {
        const groups = attribute(
            [
                container({
                    name: "qtunnel",
                    composeProject: "polaris-qtunnel-deadbeef",
                    memUsedBytes: 50
                })
            ],
            full,
            "local"
        );
        // Nothing claims the hash, so the row is the tunnel itself - left behind by
        // Polaris, since the project is ours. Badging a running container "Stopped"
        // while counting its memory says the machine is spending it on nothing.
        expect(group(groups, "leftover").rows[0]).toMatchObject({
            name: "qtunnel",
            state: "running",
            stateLabel: "Running",
            memUsedBytes: 50
        });
        expect(group(groups, "leftover").running).toBe(1);
    });

    it("still calls a tunnel whose service is gone stopped when it is", () => {
        const groups = attribute(
            [
                container({
                    name: "qtunnel",
                    composeProject: "polaris-qtunnel-deadbeef",
                    state: "exited"
                })
            ],
            full,
            "local"
        );
        expect(group(groups, "leftover").rows[0]).toMatchObject({
            state: "stopped",
            stateLabel: "Stopped"
        });
    });

    it("reads a marketplace app as the app, not as the service it runs under", () => {
        const groups = attribute(
            [
                container({
                    name: "survival",
                    composeProject: `polaris-${subjectHash(APP)}`,
                    memUsedBytes: 4000
                })
            ],
            full,
            "local"
        );
        expect(group(groups, "apps").rows[0]).toMatchObject({
            id: "1",
            name: "Survival",
            href: null
        });
        expect(group(groups, "services").rows).toHaveLength(0);
    });

    it("still gives a row to an install whose containers are on another server", () => {
        const groups = attribute([], full, "local");
        expect(group(groups, "apps").rows).toEqual([
            expect.objectContaining({
                id: "1",
                state: "elsewhere",
                containers: 0,
                memUsedBytes: null
            })
        ]);
    });

    it("gathers a managed database with the services rather than with the strangers", () => {
        const groups = attribute(
            [
                container({
                    name: "pg",
                    composeProject: `polaris-db-${subjectHash(DB)}`,
                    memUsedBytes: 700
                })
            ],
            full,
            "local"
        );
        expect(group(groups, "services").rows[0]).toMatchObject({ id: "3", memUsedBytes: 700 });
        expect(group(groups, "other").rows).toHaveLength(0);
    });

    it("leaves a container nothing here claims as itself, linked to its own page", () => {
        const groups = attribute(
            [
                container({
                    name: "someone-elses",
                    composeProject: "their-stack",
                    memUsedBytes: 20
                }),
                // A project shaped like ours whose hash resolves to nothing is not
                // an app: a record has to exist for it to be claimed. It is still
                // ours, though, so it is left behind rather than a stranger's.
                container({
                    name: "lookalike",
                    composeProject: "polaris-deadbeef",
                    memUsedBytes: 10
                })
            ],
            full,
            "local"
        );
        const rows = group(groups, "other").rows;
        expect(rows.map((row) => row.name)).toEqual(["someone-elses"]);
        expect(rows[0]?.href).toBe("/apps/containers/someone-elses?c=local");
        expect(group(groups, "leftover").rows.map((row) => row.name)).toEqual(["lookalike"]);
    });

    it("leaves an unsampled container without a figure rather than at zero", () => {
        const groups = attribute(
            [container({ name: "fresh", composeProject: "their-stack" })],
            full,
            "local"
        );
        expect(group(groups, "other").rows[0]).toMatchObject({
            cpuPercent: null,
            memUsedBytes: null
        });
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
        expect(group(groups, "other").rows.map((row) => row.name)).toEqual([
            "big",
            "middle",
            "small"
        ]);
    });
});

describe("an app that makes other installs", () => {
    // A game server and a camera worker are installs in the database and nothing
    // in the marketplace: nobody installed six Minecraft servers, they installed
    // Game servers and made six. So the app is the row and the servers are inside
    // it - which is what stops the screen reading as though somebody had gone
    // shopping nine times.
    const games = (server: string) =>
        claim(
            "install:games",
            { group: "apps", id: "games", name: "Game servers" },
            { id: server, name: server }
        );
    const held = index({
        applications: new Map([
            [subjectHash(APP), games("bed-wars")],
            [subjectHash(OTHER_APP), games("skyblock")]
        ]),
        installs: new Map([
            ["install:bed-wars", games("bed-wars")],
            ["install:skyblock", games("skyblock")]
        ])
    });

    const both = [
        container({ name: "bed-wars", composeProject: `polaris-${subjectHash(APP)}`, memUsedBytes: 300 }),
        container({ name: "skyblock", composeProject: `polaris-${subjectHash(OTHER_APP)}`, memUsedBytes: 700 })
    ];

    it("is one row, not one per thing it made", () => {
        const rows = group(attribute(both, held, "local"), "apps").rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ name: "Game servers", memUsedBytes: 1000, containers: 2 });
    });

    it("still says what each thing it made is using, which is the next question", () => {
        const parts = group(attribute(both, held, "local"), "apps").rows[0]?.parts ?? [];
        // Heaviest first inside the app, the same way the rows above are ordered.
        expect(parts.map((part) => [part.name, part.memUsedBytes])).toEqual([
            ["skyblock", 700],
            ["bed-wars", 300]
        ]);
    });

    it("counts what it made once, not once in the part and again in the group", () => {
        const groups = attribute([both[0]!], held, "local");
        expect(group(groups, "apps").memUsedBytes).toBe(300);
        expect(group(groups, "apps").containers).toBe(1);
    });

    it("gives a stopped server a row inside the app rather than dropping it", () => {
        const groups = attribute(
            [container({ name: "bed-wars", composeProject: `polaris-${subjectHash(APP)}`, state: "exited" })],
            held,
            "local"
        );
        const row = group(groups, "apps").rows[0];
        expect(row).toMatchObject({ name: "Game servers", state: "stopped" });
        expect(row?.parts.map((part) => [part.name, part.state])).toEqual([
            ["bed-wars", "stopped"],
            ["skyblock", "elsewhere"]
        ]);
    });

    it("leaves an install nothing owns as its own row", () => {
        const alone = claim("install:bridge", { group: "apps", id: "bridge", name: "Messaging bridge" });
        const groups = attribute(
            [container({ name: "bridge", composeProject: `polaris-${subjectHash(APP)}`, memUsedBytes: 50 })],
            index({ applications: new Map([[subjectHash(APP), alone]]) }),
            "local"
        );
        expect(group(groups, "apps").rows).toEqual([
            expect.objectContaining({ name: "Messaging bridge", parts: [] })
        ]);
    });
});

describe("what Polaris started and then forgot", () => {
    // The case that was being read as somebody else's: a compose project of ours
    // whose Application row is gone. It happened on a live deployment - a
    // messaging bridge holding 374 MB and a Minecraft server in a restart loop,
    // both filed under "Polaris did not start this", which is how they went on
    // holding it.
    it("is left behind rather than filed as a stranger's", () => {
        const groups = attribute(
            [container({ name: "marketplace-messaging-bridge-4b4d", composeProject: "polaris-4b4d3c47", memUsedBytes: 374 })],
            index(),
            "local"
        );
        expect(group(groups, "leftover").rows).toEqual([
            expect.objectContaining({ name: "marketplace-messaging-bridge-4b4d", memUsedBytes: 374 })
        ]);
        expect(group(groups, "other").rows).toHaveLength(0);
    });

    it("still leaves a container nobody here started where it was", () => {
        const groups = attribute([container({ name: "someone-elses", composeProject: "their-stack" })], index(), "local");
        expect(group(groups, "other").rows).toHaveLength(1);
        expect(group(groups, "leftover").rows).toHaveLength(0);
    });
});

describe("a container the engine keeps restarting", () => {
    it("says so, instead of reading as stopped", () => {
        // It is neither up nor stopped, and calling it stopped hides the one row
        // on this screen worth acting on today.
        const groups = attribute(
            [container({ name: "loop", composeProject: "polaris-cc1a3ef8", state: "restarting" })],
            index(),
            "local"
        );
        expect(group(groups, "leftover").rows[0]).toMatchObject({
            state: "restarting",
            stateLabel: "Restarting"
        });
    });

    it("counts them when an app is losing more than one", () => {
        const app = claim("install:games", { group: "apps", id: "games", name: "Game servers" });
        const groups = attribute(
            [
                container({ name: "a", composeProject: `polaris-${subjectHash(APP)}`, state: "restarting" }),
                container({ name: "b", composeProject: `polaris-${subjectHash(APP)}`, state: "restarting" })
            ],
            index({ applications: new Map([[subjectHash(APP), app]]) }),
            "local"
        );
        expect(group(groups, "apps").rows[0]?.stateLabel).toBe("2 restarting");
    });

    it("is not counted as running, which would make the group look healthy", () => {
        const groups = attribute(
            [container({ name: "loop", composeProject: "polaris-cc1a3ef8", state: "restarting" })],
            index(),
            "local"
        );
        expect(group(groups, "leftover").running).toBe(0);
    });
});
