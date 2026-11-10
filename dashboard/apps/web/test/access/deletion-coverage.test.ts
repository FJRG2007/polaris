/**
 * Every kind of thing Polaris can share is deleted somewhere, and that place
 * drops what was lent of it - a grant has no foreign key, so nothing else will.
 *
 * Table-driven on purpose: a new kind in `GRANT_SUBJECTS` fails here until it
 * is given a row naming the code that deletes it and the call that cleans up
 * after it, or a reason it is never deleted.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GRANT_SUBJECTS, type GrantSubject } from "@polaris/core";

/** Paths are relative to `apps/`. */
type Deleter = { readonly file: string; readonly call: string };

const drop = (file: string, kind: GrantSubject): Deleter => ({
    file,
    call: `dropGrantsFor("${kind}"`
});
const forget = (file: string, kind: GrantSubject): Deleter => ({
    file,
    call: `forgetSubject("${kind}"`
});

const DELETERS: Record<GrantSubject, readonly Deleter[] | string> = {
    "chat.space": [drop("web/src/lib/chat/chat-service.ts", "chat.space")],
    "chat.channel": [drop("web/src/lib/chat/chat-service.ts", "chat.channel")],
    "task.space": [forget("web/src/lib/tasks/space-service.ts", "task.space")],
    "task.folder": [forget("web/src/lib/tasks/space-service.ts", "task.folder")],
    "task.task": [
        drop("web/src/lib/tasks/task-service.ts", "task.task"),
        forget("web/src/lib/tasks/space-service.ts", "task.task")
    ],
    "note.space": [forget("web/src/lib/notes/shelf-service.ts", "note.space")],
    "note.note": [
        drop("web/src/app/(app)/notes/actions.ts", "note.note"),
        forget("web/src/lib/notes/shelf-service.ts", "note.note")
    ],
    "office.document": [drop("web/src/lib/office/documents.ts", "office.document")],
    "place.device": [{ file: "places/src/lib/devices.ts", call: `dropGrantsFor("place.device"` }],
    "place.camera": [{ file: "places/src/lib/cameras.ts", call: `dropGrantsFor("place.camera"` }],
    "place.ups": [forget("web/src/lib/ups/ups-service.ts", "place.ups")],
    "place.nas": [forget("web/src/lib/storage-service.ts", "place.nas")],
    "place.server": [drop("web/src/lib/host-service.ts", "place.server")],
    // A domain also goes with its service, environment or project by cascade,
    // so its grants are matched against what is left.
    "place.domain": [{ file: "web/src/lib/deploy-service.ts", call: "dropGrantsOfGoneDomains()" }],
    "place.room": [{ file: "places/src/lib/rooms.ts", call: `dropGrantsFor("place.room"` }],
    "place.place": [{ file: "places/src/lib/places.ts", call: `dropGrantsFor("place.place"` }],
    "place.panel": [{ file: "places/src/lib/panels.ts", call: `dropGrantsFor("place.panel"` }],
    "watch.connectivity": "one fixed record of the deployment, never deleted",
    "watch.alarm": [drop("web/src/lib/watch-service.ts", "watch.alarm")],
    "status.page": [{ file: "status-pages/src/lib/manage.ts", call: `dropGrantsFor("status.page"` }],
    "calendar.calendar": [{ file: "calendar/src/lib/trash.ts", call: `dropGrantsFor("calendar.calendar"` }],
    "calendar.booking": [{ file: "calendar/src/lib/booking.ts", call: `dropGrantsFor("calendar.booking"` }],
    "crm.record": [{ file: "crm/src/lib/records.ts", call: `dropGrantsFor("crm.record"` }],
    "crm.dashboard": [{ file: "crm/src/lib/dashboards.ts", call: `dropGrantsFor("crm.dashboard"` }],
    "automation.automation": [drop("web/src/lib/automations/service.ts", "automation.automation")],
    "analytics.site": [forget("web/src/lib/deploy-service.ts", "analytics.site")],
    "telemetry.project": [drop("web/src/app/(app)/telemetry/actions.ts", "telemetry.project")],
    "backup.plan": [drop("web/src/app/(app)/apps/backups/actions.ts", "backup.plan")],
    "dns.filter": "the house's one network filter, never deleted",
    "agents.session": [forget("web/src/lib/agents/agent-repo-service.ts", "agents.session")],
    "polar.project": [drop("web/src/app/api/polar/projects/[id]/route.ts", "polar.project")],
    "mail.mailbox": [
        drop("web/src/lib/mailbox/accounts.ts", "mail.mailbox"),
        drop("web/src/lib/mailbox/org-mailboxes.ts", "mail.mailbox")
    ]
};

/** Deletes that take more with them by cascade than they can name. */
const SWEEPS = [
    { file: "web/src/lib/user-admin-service.ts", calls: ['forgetPrincipal("user"', "sweepOrphanGrants()"] },
    { file: "web/src/lib/orgs/org-service.ts", calls: ['forgetPrincipal("team"', "sweepOrphanGrants()"] },
    { file: "web/src/lib/orgs/role-service.ts", calls: ['forgetPrincipal("role"'] },
    { file: "places/src/lib/places.ts", calls: ["sweepOrphanGrants()"] }
];

const source = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");

describe("every shareable kind is cleaned up when it is deleted", () => {
    it("has a row for every kind, and none for a kind that no longer exists", () => {
        expect(Object.keys(DELETERS).sort()).toEqual([...GRANT_SUBJECTS].sort());
    });

    for (const kind of GRANT_SUBJECTS) {
        const deleters = DELETERS[kind];
        if (typeof deleters === "string") continue;
        it(`${kind} drops its grants where it is deleted`, () => {
            expect(deleters.length).toBeGreaterThan(0);
            for (const { file, call } of deleters) expect(source(file)).toContain(call);
        });
    }

    for (const { file, calls } of SWEEPS)
        it(`${file} sweeps what its cascade leaves`, () => {
            for (const call of calls) expect(source(file)).toContain(call);
        });
});
