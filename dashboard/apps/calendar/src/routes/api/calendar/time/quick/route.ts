/**
 * Start a clock from a line typed into the search: POST `{ command, zone }`,
 * where `command` is "timer 10m tea", "alarm 7:30" or "stopwatch". The line is
 * read again here with the same parser the search used, so what the search
 * offered is what is made; anything it does not read is refused, never guessed.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import * as model from "../../../../../lib/clock/model";
import * as clock from "../../../../../lib/clock/service";
import { apiCalendarUser } from "../../../../../lib/access";
import { CalendarRefusal } from "../../../../../lib/errors";
import { calendarT } from "../../../../../lib/i18n";
import { isKnownZone } from "../../../../../lib/schemas";

const body = core.clockCommandRequestSchema.extend({
    zone: z.string().trim().min(1).max(64).refine(isKnownZone)
});

const pad = (value: number) => String(value).padStart(2, "0");

export async function POST(request: Request): Promise<Response> {
    // Only this dashboard's own pages start clocks.
    if (request.headers.get("sec-fetch-site") === "cross-site")
        return Response.json({ error: "origin" }, { status: 403 });
    const user = await apiCalendarUser();
    if (user instanceof Response) return user;
    let raw: unknown;
    try {
        raw = await request.json();
    } catch {
        return Response.json({ error: "body" }, { status: 400 });
    }
    const parsed = body.safeParse(raw);
    const command = parsed.success ? core.parseClockCommand(parsed.data.command) : null;
    const t = await calendarT();
    if (!parsed.success || !command)
        return Response.json({ error: t("time.errors.notACommand") }, { status: 400 });
    try {
        if (command.kind === "timer") {
            await clock.createTimer(
                user.id,
                model.timerInputSchema.parse({
                    label: command.label,
                    durationMs: command.durationMs,
                    sound: "chime",
                    start: true
                })
            );
        } else if (command.kind === "alarm") {
            await clock.saveAlarm(
                user.id,
                null,
                model.alarmInputSchema.parse({
                    time: `${pad(command.hour)}:${pad(command.minute)}`,
                    days: 0,
                    label: command.label,
                    sound: "chime",
                    snoozeMinutes: 10,
                    enabled: true
                }),
                parsed.data.zone
            );
        } else {
            await clock.changeStopwatch(user.id, "start");
        }
        return Response.json(
            { kind: command.kind, snapshot: await clock.clockSnapshot(user.id) },
            { headers: { "cache-control": "no-store" } }
        );
    } catch (caught) {
        if (caught instanceof z.ZodError)
            return Response.json({ error: t("time.errors.notACommand") }, { status: 400 });
        if (caught instanceof CalendarRefusal)
            return Response.json({ error: caught.message }, { status: 409 });
        console.error("polaris: a clock could not be started from search:", caught);
        return Response.json({ error: t("errors.generic") }, { status: 500 });
    }
}

