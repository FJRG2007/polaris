/**
 * Calendar, as a tool an agent can call.
 *
 * "What do I have coming up" is the calendar question an assistant is asked
 * most, and it is the one core can answer: Calendar is an installable app, and
 * core never imports an app's modules (`lib/app-extensions/types.ts`). What it
 * may do is ask the extension registry, and the one calendar question the
 * registry answers is the Overview card's - this account's next events from the
 * calendars it shows, over the next two weeks, read by the app's own access
 * rules.
 *
 * Deliberately not offered, for that reason: creating, moving or deleting an
 * event, and reading an arbitrary date range. Those are the app's to expose,
 * through a hook of its own, rather than core's to reach around it for.
 */

import { z } from "zod";
import { MAX_PAGE } from "./paging";
import { McpRefusal, type McpTool } from "../protocol";

const upcomingInput = z.object({
    limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE)
        .default(25)
        .describe("How many events to return, soonest first.")
});

const upcomingTool: McpTool<z.infer<typeof upcomingInput>> = {
    name: "calendar_upcoming",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Upcoming events",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "This account's next events over the coming two weeks, soonest first, from the calendars it shows. Read-only: it cannot create, change or delete an event.",
    input: upcomingInput,
    scope: "calendar.use",
    readOnly: true,
    async run(input, caller) {
        // Loaded here rather than with the catalogue: the registry reaches every
        // installed app's extension, which listing the tools has no need of.
        const { upcomingEventsFor } = await import("@/lib/app-extensions/registry");
        const events = await upcomingEventsFor(caller.userId, input.limit);
        if (!events) throw new McpRefusal("The Calendar app is not installed on this Polaris.");
        const rows = events.map((event) => ({
            id: event.id,
            title: event.title,
            start: event.start,
            allDay: event.allDay
        }));
        if (rows.length === 0) {
            return { text: "Nothing in the next two weeks.", structured: { events: [] } };
        }
        return {
            text: rows
                .map((row) => `${row.allDay ? row.start.slice(0, 10) : row.start}  ${row.title}${row.allDay ? " (all day)" : ""}`)
                .join("\n"),
            structured: { events: rows }
        };
    }
};

export const CALENDAR_TOOLS = [upcomingTool] as unknown as McpTool<never>[];
