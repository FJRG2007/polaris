"use client";

/**
 * The card beside an event that was pressed, and the one beside a range that
 * was selected.
 *
 * The event card shows what the grid already knows at once and reads the rest
 * (the description, the reader's own answer) behind it. The new-event card asks
 * for a title and a calendar and saves; "More details" carries what was typed
 * into the full editor.
 */

import { useCalendarT } from "./i18n";
import { unwrap } from "./cached-read";
import { isWebLink } from "./editor-model";
import { RespondBar } from "./event-editor";
import * as eventActions from "../actions/events";
import { useEffect, useId, useState } from "react";
import { Button, Input, Select } from "@polaris/ui";
import { AnchoredPanel, ColorDot, Linkified } from "./ui";
import { formatDay, addDays } from "./time";
import type { CalendarSummary, EventDetail, OccurrenceView } from "../lib/wire";
import { CalendarClock, Copy, Download, MapPin, Pencil, Trash2, Video } from "lucide-react";

export function whenOf(occurrence: OccurrenceView, locale: string, zone: string): string {
    if (occurrence.allDay && occurrence.startDate) {
        const last = occurrence.endDate ? addDays(occurrence.endDate, -1) : occurrence.startDate;
        if (last <= occurrence.startDate)
            return formatDay(occurrence.startDate, locale, { dateStyle: "full" });
        return new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeZone: "UTC"
        }).formatRange(
            new Date(`${occurrence.startDate}T12:00:00Z`),
            new Date(`${last}T12:00:00Z`)
        );
    }
    return new Intl.DateTimeFormat(locale, {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: zone
    }).formatRange(new Date(occurrence.start), new Date(occurrence.end));
}

export function EventCard({
    occurrence,
    calendar,
    anchor,
    zone,
    locale,
    onClose,
    onEdit,
    onDelete,
    onDuplicate,
    onChanged
}: {
    occurrence: OccurrenceView;
    calendar: CalendarSummary | undefined;
    anchor: DOMRect | null;
    zone: string;
    locale: string;
    onClose: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onDuplicate: () => void;
    onChanged: () => void;
}) {
    const t = useCalendarT();
    const [detail, setDetail] = useState<EventDetail | null>(null);
    const title = occurrence.busyOnly
        ? t("screen.busy")
        : occurrence.summary || t("screen.untitled");

    useEffect(() => {
        if (occurrence.busyOnly) return;
        let live = true;
        unwrap(
            () =>
                eventActions.openEventAction({
                    objectId: occurrence.objectId,
                    recurrenceKey: occurrence.recurring ? occurrence.recurrenceKey : null,
                    zone
                }),
            t("screen.failed")
        )
            .then((answer) => live && setDetail(answer.detail))
            // The card still says what the grid knew; the editor reports the failure if opened.
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [
        occurrence.objectId,
        occurrence.recurrenceKey,
        occurrence.recurring,
        occurrence.busyOnly,
        zone,
        t
    ]);

    return (
        <AnchoredPanel
            open
            onOpenChange={(open) => !open && onClose()}
            anchor={anchor}
            title={title}
        >
            <div className="flex flex-col gap-3 pr-1">
                <div className="flex items-start gap-2">
                    <ColorDot
                        color={occurrence.color ?? calendar?.color ?? "#7f7f7f"}
                        className="mt-1.5"
                    />
                    <div className="min-w-0 flex-1">
                        <p
                            className={
                                occurrence.status === "CANCELLED"
                                    ? "break-words text-[0.9375rem] font-medium line-through"
                                    : "break-words text-[0.9375rem] font-medium"
                            }
                        >
                            {title}
                        </p>
                        <p className="flex items-start gap-1.5 text-xs text-muted-foreground tabular-nums">
                            <CalendarClock aria-hidden className="mt-px size-3.5" />
                            {whenOf(occurrence, locale, zone)}
                        </p>
                    </div>
                </div>
                {occurrence.location ? (
                    <p className="flex items-start gap-1.5 text-xs">
                        <MapPin aria-hidden className="mt-px size-3.5 text-foreground-subtle" />
                        <span className="min-w-0 break-words">{occurrence.location}</span>
                    </p>
                ) : null}
                {occurrence.conference && isWebLink(occurrence.conference) ? (
                    <Button asChild size="sm" variant="outline" className="self-start">
                        <a href={occurrence.conference} target="_blank" rel="noopener noreferrer">
                            <Video />
                            {t("editor.join")}
                        </a>
                    </Button>
                ) : null}
                {detail?.event.description ? (
                    <Linkified
                        text={detail.event.description}
                        className="line-clamp-6 text-xs text-muted-foreground"
                    />
                ) : null}
                {detail && !detail.isOrganizer ? (
                    <RespondBar detail={detail} zone={zone} onChanged={onChanged} />
                ) : null}
                {calendar ? (
                    <p className="flex items-center gap-1.5 text-xs text-foreground-subtle">
                        <ColorDot color={calendar.color} className="size-2" />
                        {calendar.name}
                    </p>
                ) : null}
                <div className="flex items-center gap-1 border-t border-border pt-2">
                    {!occurrence.busyOnly ? (
                        <Button size="sm" variant="secondary" onClick={onEdit}>
                            <Pencil />
                            {occurrence.editable ? t("popover.edit") : t("popover.open")}
                        </Button>
                    ) : null}
                    <span className="ml-auto flex items-center gap-1">
                        {occurrence.editable ? (
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={t("editor.duplicate")}
                                title={t("editor.duplicate")}
                                onClick={onDuplicate}
                            >
                                <Copy />
                            </Button>
                        ) : null}
                        {!occurrence.busyOnly ? (
                            <Button asChild size="icon-sm" variant="ghost">
                                <a
                                    href={`/api/calendar/export/event/${occurrence.objectId}`}
                                    download
                                    aria-label={t("editor.export")}
                                    title={t("editor.export")}
                                >
                                    <Download />
                                </a>
                            </Button>
                        ) : null}
                        {occurrence.editable ? (
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={t("editor.delete")}
                                title={t("editor.delete")}
                                onClick={onDelete}
                            >
                                <Trash2 />
                            </Button>
                        ) : null}
                    </span>
                </div>
            </div>
        </AnchoredPanel>
    );
}

export function NewEventCard({
    anchor,
    when,
    calendars,
    calendarId,
    onCalendar,
    summary,
    onSummary,
    busy,
    onSave,
    onMore,
    onClose
}: {
    anchor: DOMRect | null;
    when: string;
    calendars: readonly CalendarSummary[];
    calendarId: string;
    onCalendar: (id: string) => void;
    summary: string;
    onSummary: (summary: string) => void;
    busy: boolean;
    onSave: () => void;
    onMore: () => void;
    onClose: () => void;
}) {
    const t = useCalendarT();
    const ids = useId();
    const writable = calendars.filter(
        (calendar) =>
            calendar.writable && calendar.components.includes("VEVENT") && !calendar.hidden
    );
    const blocked = calendarId === "" ? t("popover.chooseCalendar") : null;
    return (
        <AnchoredPanel
            open
            onOpenChange={(open) => !open && onClose()}
            anchor={anchor}
            title={t("popover.newTitle")}
        >
            <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (!blocked && !busy) onSave();
                }}
            >
                <Input
                    id={`${ids}-title`}
                    aria-label={t("editor.titleField")}
                    placeholder={t("editor.titlePlaceholder")}
                    value={summary}
                    maxLength={500}
                    autoFocus
                    onChange={(event) => onSummary(event.target.value)}
                />
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground tabular-nums">
                    <CalendarClock aria-hidden className="mt-px size-3.5" />
                    {when}
                </p>
                {writable.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("popover.noWritable")}</p>
                ) : (
                    <Select
                        aria-label={t("editor.calendar")}
                        placeholder={t("editor.chooseCalendar")}
                        value={calendarId}
                        onValueChange={onCalendar}
                        options={writable.map((calendar) => ({
                            value: calendar.id,
                            label: calendar.name,
                            icon: <ColorDot color={calendar.color} />
                        }))}
                    />
                )}
                <div className="flex items-center justify-end gap-2">
                    <Button type="button" size="sm" variant="ghost" onClick={onMore}>
                        {t("popover.more")}
                    </Button>
                    <Button
                        type="submit"
                        size="sm"
                        aria-disabled={blocked !== null || busy}
                        title={blocked ?? undefined}
                        className={blocked ? "opacity-50" : undefined}
                    >
                        {busy ? t("screen.saving") : t("screen.save")}
                    </Button>
                </div>
            </form>
        </AnchoredPanel>
    );
}
