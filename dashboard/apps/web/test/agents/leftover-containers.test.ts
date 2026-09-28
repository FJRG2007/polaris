/**
 * Containers an agent session or a sign-in left running after it ended.
 *
 * What is pinned: a container whose session ended goes once the teardown that
 * ended it has had its time, one whose session is still live never does, one
 * with no row at all goes once it is old enough that its row cannot still be
 * on its way, and nothing outside the prefix is ever touched.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/hostd-client", () => ({ HostdClient: class {} }));
vi.mock("@/lib/deploy/ports-hostd", () => ({ HostdPorts: class {} }));

const { ENDED_GRACE_MS, leftoverProjects } = await import("@/lib/agents/leftover-containers");

const NOW = new Date("2026-09-28T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const PREFIX = "polaris-session-";
const ID = "8ec470cd-9e5f-416a-b541-c58f99125041";
const OTHER = "01a0a00b-35c5-7932-861e-1b2161a9b298";

const container = (id: string, age = 30 * 86_400_000) => ({
    name: `${PREFIX}${id}`,
    project: `${PREFIX}${id}`,
    createdAt: ago(age)
});

describe("which containers are left over", () => {
    it("takes down one whose session was stopped weeks ago", () => {
        const ended = new Map([[ID, ago(26 * 86_400_000)]]);
        expect(leftoverProjects([container(ID)], PREFIX, ended, NOW)).toEqual([`${PREFIX}${ID}`]);
    });

    it("leaves one whose session is still running", () => {
        expect(leftoverProjects([container(ID)], PREFIX, new Map([[ID, null]]), NOW)).toEqual([]);
    });

    it("waits while the teardown that ended it may still be running", () => {
        const ended = new Map([[ID, ago(ENDED_GRACE_MS - 1000)]]);
        expect(leftoverProjects([container(ID)], PREFIX, ended, NOW)).toEqual([]);
    });

    it("takes down one with no row, but not before its row could still be written", () => {
        expect(leftoverProjects([container(OTHER)], PREFIX, new Map(), NOW)).toEqual([
            `${PREFIX}${OTHER}`
        ]);
        expect(leftoverProjects([container(OTHER, 1000)], PREFIX, new Map(), NOW)).toEqual([]);
    });

    it("never touches a container outside the prefix", () => {
        const stranger = {
            name: "polaris-web-589",
            project: "polaris",
            createdAt: ago(86_400_000)
        };
        expect(leftoverProjects([stranger], PREFIX, new Map(), NOW)).toEqual([]);
    });
});
