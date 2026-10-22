/**
 * A redeploy marked the release it replaced removed while that release's
 * container - created in the service's own `polaris-<hash>` project, before
 * releases had projects of their own - kept running beside the new one. These pin
 * the label-based selection that now finds such a release whatever it is called,
 * and the safety rules around it: only release-shaped projects, only the services
 * asked about, never a kept project, never a fresh container.
 */

import { describe, expect, it } from "vitest";
import {
    COMPOSE_PROJECT_LABEL,
    STACK_NAMESPACE_LABEL,
    orphanedReleaseContainers,
    releaseBase,
    releaseContainersFromPs,
    releaseContainersIn,
    removalPlan,
    supersededContainers,
    type ReleaseContainer
} from "../src/release-containers.js";

const BASE = "polaris-c69533f6";
const NOW = Date.parse("2026-10-22T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function container(
    name: string,
    project: string,
    extra: Partial<ReleaseContainer> = {}
): ReleaseContainer {
    return {
        id: `${name.replace(/[^a-f0-9]/g, "a").padEnd(12, "0").slice(0, 12)}`,
        name,
        project,
        engine: "compose",
        running: true,
        createdAt: NOW - 10 * HOUR,
        ...extra
    };
}

describe("the project a release runs under", () => {
    it("reads the service's own project with or without a release marker", () => {
        expect(releaseBase(BASE)).toBe(BASE);
        expect(releaseBase(`${BASE}-ba791a7`)).toBe(BASE);
    });

    it("refuses every other shape Polaris or an operator uses", () => {
        for (const project of [
            "polaris-db-c69533f6",
            "polaris-qtunnel-c69533f6",
            "polaris-ntunnel-c69533f6",
            "polaris-sftp-c69533f6",
            "polaris-wg-abc-1",
            "polaris",
            "my-app",
            `${BASE}-Upper`,
            `${BASE}-toolongmarker`,
            "polaris-c69533f",
            null,
            undefined
        ]) {
            expect(releaseBase(project)).toBeNull();
        }
    });
});

describe("reading the engine's listing", () => {
    it("keeps release containers, compose or swarm, running or stopped", () => {
        const found = releaseContainersIn([
            {
                Id: "aaaaaaaaaaaa1111",
                Names: ["/hmars-hmars-c695"],
                State: "running",
                Created: 1_787_000_000,
                Labels: { [COMPOSE_PROJECT_LABEL]: BASE }
            },
            {
                Id: "bbbbbbbbbbbb2222",
                Names: ["/portfolio-x"],
                State: "exited",
                Created: 1_787_000_000,
                Labels: { [COMPOSE_PROJECT_LABEL]: "polaris-3f0d2a11" }
            },
            {
                Id: "cccccccccccc3333",
                Names: ["/web_web.1.xyz"],
                State: "running",
                Labels: { [STACK_NAMESPACE_LABEL]: "polaris-0a1b2c3d" }
            }
        ]);
        expect(found).toEqual([
            {
                id: "aaaaaaaaaaaa1111",
                name: "hmars-hmars-c695",
                project: BASE,
                engine: "compose",
                running: true,
                createdAt: 1_787_000_000_000
            },
            {
                id: "bbbbbbbbbbbb2222",
                name: "portfolio-x",
                project: "polaris-3f0d2a11",
                engine: "compose",
                running: false,
                createdAt: 1_787_000_000_000
            },
            {
                id: "cccccccccccc3333",
                name: "web_web.1.xyz",
                project: "polaris-0a1b2c3d",
                engine: "stack",
                running: true,
                createdAt: null
            }
        ]);
    });

    it("drops anything that is not a release, and anything malformed", () => {
        expect(
            releaseContainersIn([
                { Id: "dddd", Names: ["/polaris-web"], Labels: { [COMPOSE_PROJECT_LABEL]: "polaris" } },
                { Id: "eeee", Names: ["/db"], Labels: { [COMPOSE_PROJECT_LABEL]: "polaris-db-c69533f6" } },
                { Id: "ffff", Names: ["/mine"], Labels: null },
                { Names: ["/no-id"], Labels: { [COMPOSE_PROJECT_LABEL]: BASE } },
                null,
                "text"
            ])
        ).toEqual([]);
    });

    it("reads `docker ps` from a remote server the same way", () => {
        const output = [
            `aaaaaaaaaaaa1111\thmars-hmars-c695\trunning\t${BASE}\t\t2026-08-20 10:11:12 +0000 UTC`,
            `bbbbbbbbbbbb2222\thmars-hmars-c695-ba791a7\texited\t${BASE}-ba791a7\t\t2026-10-22 11:00:00 +0200 CEST`,
            "cccccccccccc3333\ttraefik\trunning\tpolaris\t\t2026-08-01 00:00:00 +0000 UTC",
            "dddddddddddd4444\tweb.1.abc\trunning\t\tpolaris-0a1b2c3d\tnot a date",
            ""
        ].join("\r\n");
        expect(releaseContainersFromPs(output)).toEqual([
            {
                id: "aaaaaaaaaaaa1111",
                name: "hmars-hmars-c695",
                project: BASE,
                engine: "compose",
                running: true,
                createdAt: Date.parse("2026-08-20T10:11:12Z")
            },
            {
                id: "bbbbbbbbbbbb2222",
                name: "hmars-hmars-c695-ba791a7",
                project: `${BASE}-ba791a7`,
                engine: "compose",
                running: false,
                createdAt: Date.parse("2026-10-22T09:00:00Z")
            },
            {
                id: "dddddddddddd4444",
                name: "web.1.abc",
                project: "polaris-0a1b2c3d",
                engine: "stack",
                running: true,
                createdAt: null
            }
        ]);
    });
});

describe("what a promotion takes down", () => {
    const legacy = container("hmars-hmars-c695", BASE);
    const fresh = container("hmars-hmars-c695-ba791a7", `${BASE}-ba791a7`);
    const forwarder = container("hmars-hmars-c695-ba791a7-p80", `${BASE}-ba791a7`);
    const other = container("portfolio-x", "polaris-3f0d2a11");

    it("finds the release left in the service's own project, the older naming", () => {
        const keep = new Set([`${BASE}-ba791a7`]);
        expect(supersededContainers([legacy, fresh, forwarder, other], BASE, keep)).toEqual([legacy]);
    });

    it("finds an older change-over release by its marker, whatever the row says", () => {
        const older = container("hmars-hmars-c695-0f0f0f0", `${BASE}-0f0f0f0`, { running: false });
        const keep = new Set([`${BASE}-ba791a7`]);
        expect(supersededContainers([older, fresh, forwarder], BASE, keep)).toEqual([older]);
    });

    it("leaves an in-place redeploy alone: the service's own project is the one serving", () => {
        expect(supersededContainers([legacy, other], BASE, new Set([BASE]))).toEqual([]);
    });

    it("keeps every release still on record as running", () => {
        const kept = container("hmars-hmars-c695-1234abc", `${BASE}-1234abc`);
        const keep = new Set([`${BASE}-ba791a7`, `${BASE}-1234abc`]);
        expect(supersededContainers([legacy, kept, fresh], BASE, keep)).toEqual([legacy]);
    });

    it("never reaches another service's containers", () => {
        expect(supersededContainers([other], BASE, new Set())).toEqual([]);
    });
});

describe("what the sweep removes", () => {
    const services = new Map([
        [BASE, new Set([`${BASE}-ba791a7`])],
        ["polaris-3f0d2a11", new Set(["polaris-3f0d2a11-dc94ed2"])]
    ]);

    it("removes running and stopped releases that are not kept", () => {
        const legacy = container("hmars-hmars-c695", BASE);
        const stopped = container("portfolio-x", "polaris-3f0d2a11", { running: false });
        const current = container("portfolio-x-dc94ed2", "polaris-3f0d2a11-dc94ed2");
        expect(
            orphanedReleaseContainers([legacy, stopped, current], services, NOW, HOUR)
        ).toEqual([legacy, stopped]);
    });

    it("leaves a service it was not told about alone", () => {
        // A removed service, one mid-deploy, one with no current release: none of
        // them is in the map, and the leftovers screen owns the removed ones.
        const unknown = container("marketplace-demo-4b78", "polaris-4b78aaaa", { running: false });
        expect(orphanedReleaseContainers([unknown], services, NOW, HOUR)).toEqual([]);
    });

    it("leaves a container younger than the grace, or of unknown age", () => {
        const young = container("hmars-hmars-c695-1111111", `${BASE}-1111111`, {
            createdAt: NOW - 5 * 60 * 1000
        });
        const ageless = container("hmars-hmars-c695-2222222", `${BASE}-2222222`, {
            createdAt: null
        });
        expect(orphanedReleaseContainers([young, ageless], services, NOW, HOUR)).toEqual([]);
    });

    it("never the current release", () => {
        const current = container("hmars-hmars-c695-ba791a7", `${BASE}-ba791a7`);
        expect(orphanedReleaseContainers([current], services, NOW, HOUR)).toEqual([]);
    });
});

describe("how they are taken away", () => {
    it("removes compose containers one by one and a swarm stack whole", () => {
        const one = container("a", BASE);
        const task1 = container("b", `${BASE}-1`, { engine: "stack" });
        const task2 = container("c", `${BASE}-1`, { engine: "stack" });
        expect(removalPlan([one, task1, task2])).toEqual({
            containers: [one],
            stacks: [`${BASE}-1`]
        });
    });
});
