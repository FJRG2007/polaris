/** A working week: standups, a launch, a dentist, the team's holidays. */

import { id } from "./people";
import type { SceneContext } from "../runtime/scene";
import { DEFAULT_PREFERENCES, type CalendarPreferences } from "../../../apps/calendar/src/lib/preferences";
import type { CalendarSummary, OccurrenceView, RangeView, TaskItemView } from "../../../apps/calendar/src/lib/wire";

const WORK = id("calendar", 1);
const HOME = id("calendar", 2);
const HOLIDAYS = id("calendar", 3);

export function calendarPreferences(): CalendarPreferences {
    return {
        ...DEFAULT_PREFERENCES,
        view: "week",
        timezone: "Europe/Madrid",
        dayStart: "09:00",
        firstDay: 1,
        // The first-use hint about linking accounts, already closed.
        dismissedHints: ["link-accounts"]
    };
}

function calendar(n: number, name: string, color: string, extra: Partial<CalendarSummary> = {}): CalendarSummary {
    return {
        id: [WORK, HOME, HOLIDAYS][n - 1]!,
        name,
        description: "",
        color,
        ownColor: color,
        timezone: "Europe/Madrid",
        components: ["VEVENT", "VTODO"],
        kind: "local",
        source: null,
        reach: "owner",
        owner: null,
        hidden: false,
        position: n,
        writable: true,
        transparent: false,
        alarmsMuted: false,
        defaultAlarms: { timed: [-10], allDay: [-900] },
        publicMode: "",
        publicToken: null,
        resource: null,
        shareCount: 0,
        ...extra
    };
}

export function calendars(ctx: SceneContext): CalendarSummary[] {
    return [
        calendar(1, ctx.say("Work", "Trabajo"), "#6366f1", { shareCount: 4 }),
        calendar(2, ctx.say("Personal", "Personal"), "#f59e0b"),
        calendar(3, ctx.say("Team holidays", "Vacaciones del equipo"), "#10b981", {
            kind: "remote",
            source: { id: id("calendar-source", 1), kind: "google", label: "Google", status: "ok", lastSyncAt: null },
            writable: false,
            reach: "read"
        })
    ];
}

/** Madrid is an hour ahead of UTC in March, before the clocks change. */
function at(day: number, hhmm: string): string {
    const [h, m] = hhmm.split(":").map(Number) as [number, number];
    return new Date(Date.UTC(2026, 2, day, h - 1, m)).toISOString();
}

interface Draft {
    readonly title: [string, string];
    readonly day: number;
    readonly from: string;
    readonly to: string;
    readonly calendar: string;
    readonly location?: string;
    readonly people?: number;
    readonly recurring?: boolean;
    readonly conference?: boolean;
}

const WEEKDAYS = [16, 17, 18, 19, 20];

const DRAFTS: readonly Draft[] = [
    ...WEEKDAYS.map(
        (day): Draft => ({
            title: ["Standup", "Daily"],
            day,
            from: "09:30",
            to: "09:45",
            calendar: WORK,
            people: 6,
            recurring: true,
            conference: true
        })
    ),
    { title: ["Sprint planning", "Planificación del sprint"], day: 16, from: "10:30", to: "12:00", calendar: WORK, people: 6, conference: true },
    { title: ["Design review", "Revisión de diseño"], day: 17, from: "15:00", to: "16:00", calendar: WORK, people: 3, location: "Room 2" },
    { title: ["Lunch with Priya", "Comida con Priya"], day: 17, from: "13:30", to: "14:30", calendar: HOME, location: "Mercado" },
    { title: ["Customer call: Acme", "Llamada con cliente: Acme"], day: 18, from: "12:00", to: "12:45", calendar: WORK, people: 4, conference: true },
    { title: ["Focus: release notes", "Concentración: notas"], day: 18, from: "15:30", to: "17:30", calendar: WORK },
    { title: ["Launch", "Lanzamiento"], day: 19, from: "10:00", to: "11:00", calendar: WORK, people: 6, conference: true },
    { title: ["Dentist", "Dentista"], day: 19, from: "17:30", to: "18:15", calendar: HOME },
    { title: ["Retro", "Retrospectiva"], day: 20, from: "11:00", to: "12:00", calendar: WORK, people: 6 },
    { title: ["Team drinks", "Algo con el equipo"], day: 20, from: "18:30", to: "20:00", calendar: WORK, location: "Terraza" },
    { title: ["Climbing", "Escalada"], day: 21, from: "10:00", to: "12:00", calendar: HOME }
];

export function rangeView(ctx: SceneContext, from: string, to: string): RangeView {
    const all = calendars(ctx);
    const occurrences: OccurrenceView[] = DRAFTS.map((draft, index) => {
        const start = at(draft.day, draft.from);
        return {
            objectId: id("calendar-object", index + 1),
            calendarId: draft.calendar,
            uid: `fixture-${index + 1}@example.com`,
            recurrenceKey: start,
            start,
            end: at(draft.day, draft.to),
            allDay: false,
            startDate: null,
            endDate: null,
            summary: ctx.say(...draft.title),
            location: draft.location ?? "",
            color: null,
            status: "CONFIRMED",
            transparent: false,
            recurring: draft.recurring ?? false,
            overridden: false,
            kind: "default",
            attendeeCount: draft.people ?? 0,
            myPartstat: draft.people ? "ACCEPTED" : null,
            hasAlarms: true,
            busyOnly: false,
            editable: all.find((one) => one.id === draft.calendar)?.writable ?? false,
            conference: draft.conference ? "https://meet.example.com/standup" : "",
            categories: []
        };
    });
    occurrences.push({
        ...occurrences[0]!,
        objectId: id("calendar-object", 99),
        calendarId: HOLIDAYS,
        uid: "fixture-holiday@example.com",
        recurrenceKey: "2026-03-19",
        start: at(19, "00:00"),
        end: at(20, "00:00"),
        allDay: true,
        startDate: "2026-03-19",
        endDate: "2026-03-20",
        summary: ctx.say("Kenji off", "Kenji libre"),
        location: "",
        recurring: false,
        attendeeCount: 0,
        myPartstat: null,
        hasAlarms: false,
        editable: false,
        conference: ""
    });
    const tasks: TaskItemView[] = [
        {
            source: "tasks",
            id: id("task", 2),
            calendarId: null,
            title: ctx.say("Release notes for 2.4", "Notas de la versión 2.4"),
            due: "2026-03-20",
            allDay: true,
            done: false,
            reference: "PRD-113",
            listName: ctx.say("March release", "Versión de marzo"),
            editable: true,
            statusType: "open",
            statusColor: "#94a3b8",
            statusName: ctx.say("To do", "Por hacer")
        }
    ];
    return { from, to, occurrences, tasks, unreadable: 0, truncated: false };
}
