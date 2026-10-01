"use client";

/**
 * Bringing a calendar file in (iCalendar or jCal, into a calendar or a new
 * one, with what could not be read listed) and taking any calendar out as an
 * .ics file.
 */

import { ColorDot } from "./ui";
import { useCalendarT } from "./i18n";
import { unwrap } from "./cached-read";
import { Download, FileUp } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { CalendarSummary } from "../lib/wire";
import * as transferActions from "../actions/transfer";
import { CALENDAR_COLORS, nameSchema } from "../lib/schemas";
import { Button, cn, Input, Select, Skeleton } from "@polaris/ui";

const MOST_BYTES = 10 * 1024 * 1024;
const NEW = "new";

interface Outcome {
    readonly calendarId: string;
    readonly imported: number;
    readonly skipped: number;
    readonly problems: readonly string[];
}

export function ImportExport({
    calendars,
    zone,
    onImported
}: {
    calendars: readonly CalendarSummary[] | null;
    zone: string;
    onImported: () => void;
}) {
    const t = useCalendarT();
    const ids = useId();
    const input = useRef<HTMLInputElement>(null);
    const [file, setFile] = useState<{ name: string; text: string } | null>(null);
    const [target, setTarget] = useState<string>(NEW);
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    const [dragging, setDragging] = useState(false);

    const writable = (calendars ?? []).filter((calendar) => calendar.writable);
    const read = async (chosen: File | undefined) => {
        setOutcome(null);
        setProblem(null);
        if (!chosen) return;
        if (chosen.size > MOST_BYTES) {
            setProblem(t("transferSection.tooBig"));
            return;
        }
        const text = await chosen.text();
        setFile({ name: chosen.name, text });
        if (!name) setName(chosen.name.replace(/\.(ics|ical|ifb|json|jcal)$/i, ""));
    };

    const nameOk = target !== NEW || nameSchema.safeParse(name).success;
    const blocked = !file
        ? t("transferSection.chooseFile")
        : !nameOk
          ? t("transferSection.nameNeeded")
          : null;

    const run = async () => {
        if (!file || blocked || busy) return;
        setBusy(true);
        setProblem(null);
        try {
            const used = (calendars ?? []).map((calendar) => calendar.ownColor);
            const color =
                CALENDAR_COLORS.find((candidate) => !used.includes(candidate)) ??
                CALENDAR_COLORS[0];
            const answer = await unwrap(
                () =>
                    transferActions.importCalendarAction({
                        target:
                            target === NEW
                                ? { kind: "new", name, color }
                                : { kind: "existing", calendarId: target },
                        text: file.text,
                        zone
                    }),
                t("screen.failed")
            );
            setOutcome({
                calendarId: answer.calendarId,
                imported: answer.imported,
                skipped: answer.skipped,
                problems: answer.problems
            });
            setFile(null);
            if (input.current) input.current.value = "";
            onImported();
        } catch (caught) {
            setProblem(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-3" aria-labelledby={`${ids}-import`}>
                <h3 id={`${ids}-import`} className="text-[0.8125rem] font-medium">
                    {t("transferSection.import")}
                </h3>
                <div
                    onDragOver={(event) => {
                        event.preventDefault();
                        setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                        event.preventDefault();
                        setDragging(false);
                        void read(event.dataTransfer.files[0]);
                    }}
                    className={cn(
                        "flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-5 text-center",
                        dragging ? "border-foreground" : "border-border"
                    )}
                >
                    <FileUp aria-hidden className="size-5 text-foreground-subtle" />
                    <p className="text-xs text-muted-foreground">
                        {file
                            ? t("transferSection.chosen", { name: file.name })
                            : t("transferSection.drop")}
                    </p>
                    <input
                        ref={input}
                        id={`${ids}-file`}
                        type="file"
                        accept=".ics,.ical,.ifb,.json,.jcal,text/calendar,application/calendar+json"
                        className="sr-only"
                        onChange={(event) => void read(event.target.files?.[0])}
                    />
                    <Button size="sm" variant="outline" onClick={() => input.current?.click()}>
                        {t("transferSection.pick")}
                    </Button>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                        {t("transferSection.into")}
                        <Select
                            aria-label={t("transferSection.into")}
                            value={target}
                            onValueChange={setTarget}
                            options={[
                                { value: NEW, label: t("transferSection.newCalendar") },
                                ...writable.map((calendar) => ({
                                    value: calendar.id,
                                    label: calendar.name,
                                    icon: <ColorDot color={calendar.color} />
                                }))
                            ]}
                        />
                    </label>
                    {target === NEW ? (
                        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                            {t("transferSection.newName")}
                            <Input
                                value={name}
                                maxLength={120}
                                required
                                aria-required
                                onChange={(event) => setName(event.target.value)}
                            />
                        </label>
                    ) : null}
                    <Button
                        aria-disabled={blocked !== null || busy}
                        title={blocked ?? undefined}
                        className={cn(blocked !== null && "opacity-50")}
                        onClick={() => void run()}
                    >
                        {busy ? t("transferSection.importing") : t("transferSection.run")}
                    </Button>
                </div>
                {problem ? (
                    <p role="alert" className="text-xs text-danger">
                        {problem}
                    </p>
                ) : null}
                {outcome ? (
                    <div
                        role="status"
                        className="flex flex-col gap-1 rounded-md border border-border p-3 text-xs"
                    >
                        <p className="text-foreground tabular-nums">
                            {t("transferSection.done", {
                                imported: outcome.imported,
                                skipped: outcome.skipped
                            })}
                        </p>
                        {outcome.problems.length > 0 ? (
                            <ul className="list-disc pl-4 text-muted-foreground">
                                {outcome.problems.slice(0, 20).map((line, index) => (
                                    <li key={index}>{line}</li>
                                ))}
                            </ul>
                        ) : null}
                    </div>
                ) : null}
            </section>

            <section className="flex flex-col gap-2" aria-labelledby={`${ids}-export`}>
                <div className="flex flex-wrap items-center gap-2">
                    <h3
                        id={`${ids}-export`}
                        className="min-w-0 flex-1 text-[0.8125rem] font-medium"
                    >
                        {t("transferSection.export")}
                    </h3>
                    <Button asChild size="sm" variant="outline">
                        <a
                            href="/api/calendar/export/all"
                            download
                            title={t("transferSection.everythingHint")}
                        >
                            <Download />
                            {t("transferSection.everything")}
                        </a>
                    </Button>
                </div>
                {!calendars ? (
                    <div className="flex flex-col gap-1.5" aria-hidden>
                        <Skeleton className="h-6 w-full" />
                        <Skeleton className="h-6 w-2/3" />
                    </div>
                ) : (
                    <ul className="flex flex-col">
                        {calendars
                            .filter((calendar) => calendar.reach !== "freebusy")
                            .map((calendar) => (
                                <li
                                    key={calendar.id}
                                    className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 hover:bg-card-hover"
                                >
                                    <ColorDot color={calendar.color} />
                                    <span
                                        className="min-w-0 flex-1 truncate text-[0.8125rem]"
                                        title={calendar.name}
                                    >
                                        {calendar.name}
                                    </span>
                                    <Button asChild size="icon-sm" variant="ghost">
                                        <a
                                            href={`/api/calendar/export/${calendar.id}`}
                                            download
                                            aria-label={t("transferSection.download", {
                                                name: calendar.name
                                            })}
                                            title={t("transferSection.download", {
                                                name: calendar.name
                                            })}
                                        >
                                            <Download />
                                        </a>
                                    </Button>
                                </li>
                            ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
