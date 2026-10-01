/**
 * What follows a stored object changing, in one place: its reminders are
 * planned again, a booking made for it follows it, a provider calendar is told,
 * and the people invited to it hear about it. Called by `objects.writeItem`,
 * the trash and a pull's removals, never by a screen.
 *
 * Each effect is separate and none can undo the write: the event is saved the
 * moment the row is, and a provider that is down or a mail channel that refuses
 * is recorded against the object and retried, not thrown at the person saving.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import type { CalendarItem } from "../engine";
import type { WriteContext } from "./objects";

export interface ObjectChange {
    readonly objectId: string;
    readonly calendarId: string;
    /** The item before the change; null for a new object. */
    readonly before: CalendarItem | null;
    /** The item after it; null when it was removed. */
    readonly after: CalendarItem | null;
    readonly context: WriteContext;
}

/** Bring everything that depends on an object in step with it. */
export async function afterObjectChange(change: ObjectChange): Promise<void> {
    const calendar = await prisma.calendar.findUnique({
        where: { id: change.calendarId },
        select: { id: true, kind: true, sourceId: true, ownerId: true, alarmsMuted: true }
    });
    if (!calendar) return;

    const reminders = await import("./reminders");
    await reminders
        .planObject(change.objectId, change.after && !calendar.alarmsMuted ? change.after : null)
        .catch((caught: unknown) => console.error("polaris: calendar reminders were not planned:", caught));

    const booking = await import("./booking");
    await booking
        .followEvent(change)
        .catch((caught: unknown) => console.error("polaris: a booking did not follow its event:", caught));

    if (calendar.sourceId && !change.context.fromProvider) {
        const sync = await import("./sync-engine");
        await sync.pushChange(change.objectId, calendar.sourceId, change.after === null);
    }

    // A provider schedules its own events: Google and Microsoft send their
    // invitations, and a CalDAV server with scheduling does too. Polaris sends
    // them only for its own calendars, and never for what a pull brought in.
    if (
        !change.context.fromProvider &&
        !change.context.fromImport &&
        !change.context.moving &&
        calendar.kind === "local"
    ) {
        const invitations = await import("./invitations");
        await invitations
            .afterChange(change, calendar.ownerId)
            .catch((caught: unknown) => console.error("polaris: calendar invitations were not sent:", caught));
    }
}
