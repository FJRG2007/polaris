"use client";

/**
 * When the server is up, and when it may go quiet.
 *
 * Written as windows over the week rather than a start time and a stop time,
 * because the thing people actually want is neither: it is "asleep overnight
 * unless somebody is playing, up the rest of the day". A window says one of three
 * things - be on, be off, or sleep when empty - and everything no window covers
 * falls to a default, so that sentence is one rule and not six.
 *
 * Sleeping is deliberately one-way. A window that says sleep lets a server stop
 * once nobody has played for a while; it never starts one, because a server that
 * woke at three in the morning would only find itself empty and stop again.
 * Coming back is a window that says on, or somebody pressing start.
 */

import { useMemo, useState, useTransition } from "react";
import { saveGameScheduleAction } from "./minecraft-actions";
import { Button, Card, CardBody, Input, Select, Switch } from "@polaris/ui";
import { CalendarClock, Loader2, Moon, Plus, Power, Trash2 } from "lucide-react";
import {
    describeSchedule,
    MAX_IDLE_MINUTES,
    MIN_IDLE_MINUTES,
    NO_SCHEDULE,
    type GameSchedule,
    type GameScheduleMode,
    type GameScheduleWindow
} from "@/lib/apps/minecraft/schedule";

/** What each mode does, in the words the operator has to choose between. */
const MODES: { value: GameScheduleMode; label: string; hint: string }[] = [
    { value: "on", label: "Keep running", hint: "Started if it is down." },
    { value: "sleep", label: "Sleep when empty", hint: "Stopped once nobody has played for a while." },
    { value: "off", label: "Keep stopped", hint: "Stopped even if somebody is on." }
];

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A first window that is the rule almost everybody is here to write. */
const OVERNIGHT: GameScheduleWindow = { days: [], from: "00:00", to: "10:00", mode: "sleep" };

export function MinecraftSchedule({
    installedAppId,
    schedule: saved
}: {
    installedAppId: string;
    schedule: GameSchedule;
}) {
    const [schedule, setSchedule] = useState<GameSchedule>(saved);
    const [error, setError] = useState<string | null>(null);
    const [saved_, setSavedNote] = useState(false);
    const [pending, startTransition] = useTransition();

    // A form is dirty when its values differ from the ones it loaded, not when
    // somebody has touched it: a window opened and closed again is no change.
    const changed = useMemo(() => JSON.stringify(schedule) !== JSON.stringify(saved), [schedule, saved]);
    const summary = useMemo(() => describeSchedule(schedule, new Date()), [schedule]);

    function update(patch: Partial<GameSchedule>): void {
        setSavedNote(false);
        setSchedule((current) => ({ ...current, ...patch }));
    }

    function updateWindow(index: number, patch: Partial<GameScheduleWindow>): void {
        update({
            windows: schedule.windows.map((window, at) => (at === index ? { ...window, ...patch } : window))
        });
    }

    function save(): void {
        setError(null);
        startTransition(async () => {
            const result = await saveGameScheduleAction({ installedAppId, schedule });
            if (result.error) {
                setError(result.error);
                return;
            }
            setSavedNote(true);
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <p className="flex items-center gap-2 text-sm font-medium">
                            <CalendarClock className="size-4" /> Schedule
                        </p>
                        <p className="max-w-xl text-xs text-muted-foreground">
                            Hours the server is kept up, and hours it may stop once nobody is playing. Times are read
                            where you say, not where the machine is. Nothing here restarts the server to take effect.
                        </p>
                    </div>
                    <Switch
                        checked={schedule.enabled}
                        onChange={(enabled) => update({ enabled })}
                        aria-label="Follow this schedule"
                    />
                </div>

                {schedule.enabled && (
                    <>
                        <div className="grid gap-3 sm:grid-cols-3">
                            <Field label="Time zone">
                                <Select
                                    value={schedule.timezone}
                                    onValueChange={(timezone) => update({ timezone })}
                                    aria-label="The zone the times are read in"
                                    options={timezoneOptions(schedule.timezone)}
                                />
                            </Field>
                            <Field label="The rest of the time">
                                <Select
                                    value={schedule.otherwise}
                                    onValueChange={(otherwise) => update({ otherwise: otherwise as GameScheduleMode })}
                                    aria-label="What happens outside every window"
                                    options={MODES.map((mode) => ({ value: mode.value, label: mode.label }))}
                                />
                            </Field>
                            <Field label="Empty for">
                                <div className="flex items-center gap-2">
                                    <Input
                                        type="number"
                                        min={MIN_IDLE_MINUTES}
                                        max={MAX_IDLE_MINUTES}
                                        value={String(schedule.idleMinutes)}
                                        aria-label="Minutes with nobody playing before a sleeping window stops it"
                                        onChange={(event) =>
                                            update({ idleMinutes: Number.parseInt(event.target.value, 10) || 0 })
                                        }
                                    />
                                    <span className="shrink-0 text-xs text-muted-foreground">minutes</span>
                                </div>
                            </Field>
                        </div>

                        <div className="flex flex-col gap-2">
                            {schedule.windows.length === 0 ? (
                                <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                                    No windows yet, so the whole week follows the rule above.
                                </p>
                            ) : (
                                schedule.windows.map((window, index) => (
                                    <WindowRow
                                        key={index}
                                        window={window}
                                        onChange={(patch) => updateWindow(index, patch)}
                                        onRemove={() =>
                                            update({ windows: schedule.windows.filter((_, at) => at !== index) })
                                        }
                                    />
                                ))
                            )}
                            <Button
                                size="sm"
                                variant="secondary"
                                className="w-fit"
                                onClick={() => update({ windows: [...schedule.windows, OVERNIGHT] })}
                            >
                                <Plus className="size-4" /> Add a window
                            </Button>
                        </div>

                        <p className="flex items-center gap-2 text-xs text-muted-foreground">
                            {schedule.enabled && summary.includes("nobody") ? (
                                <Moon className="size-3.5" />
                            ) : (
                                <Power className="size-3.5" />
                            )}
                            {summary}
                        </p>
                    </>
                )}

                {error && <p className="text-sm text-danger">{error}</p>}

                <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                        {saved_ && !changed ? "Saved." : changed ? "Not saved yet." : "This is what the server follows."}
                    </span>
                    <Button onClick={save} disabled={pending || !changed}>
                        {pending && <Loader2 className="size-4 animate-spin" />}
                        Save schedule
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

function WindowRow({
    window,
    onChange,
    onRemove
}: {
    window: GameScheduleWindow;
    onChange: (patch: Partial<GameScheduleWindow>) => void;
    onRemove: () => void;
}) {
    const wraps = window.to <= window.from;

    return (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-end gap-2">
                <Field label="From">
                    <Input
                        type="time"
                        className="w-28"
                        value={window.from}
                        aria-label="When the window starts"
                        onChange={(event) => onChange({ from: event.target.value })}
                    />
                </Field>
                <Field label="To">
                    <Input
                        type="time"
                        className="w-28"
                        value={window.to}
                        aria-label="When the window ends"
                        onChange={(event) => onChange({ to: event.target.value })}
                    />
                </Field>
                <Field label="Then">
                    <Select
                        className="w-48"
                        value={window.mode}
                        onValueChange={(mode) => onChange({ mode: mode as GameScheduleMode })}
                        aria-label="What the server does in this window"
                        options={MODES.map((mode) => ({ value: mode.value, label: mode.label }))}
                    />
                </Field>
                <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto text-danger hover:text-danger"
                    onClick={onRemove}
                    aria-label="Remove this window"
                    title="Remove this window"
                >
                    <Trash2 className="size-4" />
                </Button>
            </div>

            <div className="flex flex-wrap items-center gap-1">
                {DAYS.map((label, day) => {
                    const every = window.days.length === 0;
                    const picked = every || window.days.includes(day);
                    return (
                        <button
                            key={label}
                            type="button"
                            aria-pressed={picked}
                            onClick={() =>
                                onChange({
                                    days: every
                                        ? DAYS.map((_, index) => index).filter((index) => index !== day)
                                        : picked
                                          ? window.days.filter((held) => held !== day)
                                          : [...window.days, day].sort()
                                })
                            }
                            className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                                picked
                                    ? "border-primary/50 bg-primary/10 text-foreground"
                                    : "border-border text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            {label}
                        </button>
                    );
                })}
                <span className="ml-1 text-xs text-muted-foreground">
                    {[window.days.length === 0 ? "Every day" : null, wraps ? "runs past midnight" : null]
                        .filter(Boolean)
                        .join(", ")}
                </span>
            </div>
        </div>
    );
}

/**
 * The zones to offer.
 *
 * The browser's own first, because it is the one the person reading this is in
 * and the times they are about to type are in their head in it. UTC is there for
 * anybody coordinating across places, and whatever the server was already set to
 * so a saved schedule never silently reads as something else.
 */
function timezoneOptions(current: string): { value: string; label: string }[] {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const supported =
        typeof Intl.supportedValuesOf === "function"
            ? Intl.supportedValuesOf("timeZone")
            : [...new Set([here, current, "UTC"])];
    const preferred = [...new Set([here, current, "UTC"])];
    return [...preferred, ...supported.filter((zone) => !preferred.includes(zone))].map((zone) => ({
        value: zone,
        label: zone === here ? `${zone} (yours)` : zone
    }));
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">{label}</span>
            {children}
        </label>
    );
}

export { NO_SCHEDULE };
