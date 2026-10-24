/**
 * A calendar handed to an organization role (`calendar.calendar`). Somebody
 * holding the role reaches it at the level given - `view` reads, `edit` also
 * changes events - alongside CalendarShare for people and teams; nothing once
 * the grant is taken back; and a grant here may only ever be to a role.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    granted: new Map<string, string>(),
    shares: [] as { calendarId: string; access: string }[]
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        calendarHost: { teamIdsOf: vi.fn(async () => []) },
        accessGrants: { grantedSubjects: vi.fn(async () => new Map(state.granted)) }
    }
}));
vi.mock("@polaris/db", () => ({
    prisma: { calendarShare: { findMany: vi.fn(async () => state.shares) } }
}));
vi.mock("@polaris-app/calendar/src/lib/i18n", () => ({
    calendarT: async () => (key: string) => key
}));

const { reachOf, roleShares } = await import("@polaris-app/calendar/src/lib/access");

const calendar = (id: string, ownerId = "owner") => ({
    id,
    ownerId,
    kind: "personal",
    trashedAt: null
});

describe("a calendar handed to a role", () => {
    beforeEach(() => {
        state.granted = new Map();
        state.shares = [];
    });

    it("reads as a share level: view reads, edit writes", async () => {
        state.granted = new Map([
            ["c1", "view"],
            ["c2", "edit"]
        ]);
        expect(await roleShares("u1")).toEqual(
            new Map([
                ["c1", "read"],
                ["c2", "write"]
            ])
        );
        const reach = await reachOf("u1", [calendar("c1"), calendar("c2"), calendar("c3")]);
        expect(reach.get("c1")).toBe("read");
        expect(reach.get("c2")).toBe("write");
        expect(reach.has("c3")).toBe(false);
    });

    it("keeps the stronger of a person's own share and the role's", async () => {
        state.granted = new Map([["c1", "view"]]);
        state.shares = [{ calendarId: "c1", access: "manage" }];
        expect((await reachOf("u1", [calendar("c1")])).get("c1")).toBe("manage");
    });

    it("reaches nothing once the grant is taken back", async () => {
        state.granted = new Map([["c1", "edit"]]);
        expect((await reachOf("u1", [calendar("c1")])).get("c1")).toBe("write");
        state.granted = new Map();
        expect((await reachOf("u1", [calendar("c1")])).has("c1")).toBe(false);
    });
});

describe("the calendar subject", () => {
    it("is only ever handed to a role, as view or edit, never as a link", () => {
        expect(core.GRANT_CAPABILITIES["calendar.calendar"]).toEqual(["view", "edit"]);
        expect(core.subjectPrincipals("calendar.calendar")).toEqual(["role"]);
        expect(core.subjectPrincipals("watch.alarm")).toEqual(core.GRANT_PRINCIPALS);
        expect(core.isGrantLinkSubject("calendar.calendar")).toBe(false);
    });
});

describe("a subject only its notice leads to", () => {
    it("is handed to a person, the one principal that notice reaches", () => {
        for (const subject of ["note.note", "task.task", "agents.session"] as const) {
            expect(core.subjectPrincipals(subject)).toEqual(["user"]);
        }
    });
});
