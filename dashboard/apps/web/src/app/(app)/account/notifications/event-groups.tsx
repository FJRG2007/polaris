"use client";

/**
 * The events, one collapsible card per group, the way Slack and Discord fold
 * their channel lists. A folded card still says how many of its events reach
 * you and whether the group is muted or on a schedule, so the page can stay
 * short without hiding anything that matters. Which cards are open is kept in
 * this browser.
 *
 * Each row is one line where it fits: the name, the delivery chips, and a menu
 * to mute the event for a while or give it hours. The same menu on a card's
 * header does it for the whole group.
 */

import * as core from "@polaris/core";
import { useEffect, useMemo, useState } from "react";
import {
    Bell,
    BellOff,
    CalendarClock,
    ChevronRight,
    Mail,
    MoreHorizontal,
    Smartphone,
    Webhook
} from "lucide-react";
import {
    Badge,
    Button,
    Card,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    cn
} from "@polaris/ui";
import { WeekdayPicker } from "@/components/weekday-picker";
import { useDisplayFormat } from "@/components/display-format";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import type { DestinationView } from "@/lib/notifications/destinations";
import { eventDescription, eventLabel, groupLabel } from "./event-names";

type Translate = NamespaceTranslator<"accountNotifications">;

/** Where this browser keeps which groups are open. */
const OPEN_GROUPS_KEY = "polaris.notifications.openGroups";

function readOpenGroups(): Set<string> {
    try {
        const raw = window.localStorage.getItem(OPEN_GROUPS_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
    } catch {
        return new Set();
    }
}

function writeOpenGroups(open: Set<string>) {
    try {
        window.localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify([...open]));
    } catch {
        // Private windows and full storage: the cards just open folded next time.
    }
}

/** How many of a group's events reach the account somewhere. */
export function groupSummary(
    events: readonly { id: string }[],
    state: Map<string, core.NotificationRule>
): { on: number; total: number } {
    let on = 0;
    let total = 0;
    for (const entry of events) {
        const rule = state.get(entry.id);
        if (!rule) continue;
        total += 1;
        if (!core.isMuted(rule)) on += 1;
    }
    return { on, total };
}

export interface HoldControls {
    holds: core.NotificationHolds;
    timeZone: string;
    onMute: (target: core.HoldTarget, duration: core.NotificationMuteDuration | null) => void;
    onSchedule: (target: core.HoldTarget, schedule: core.NotificationSchedule | null) => void;
}

export function EventGroups({
    state,
    destinations,
    onChange,
    hold
}: {
    state: Map<string, core.NotificationRule>;
    destinations: DestinationView[];
    onChange: (event: string, rule: core.NotificationRule) => void;
    hold: HoldControls;
}) {
    // Folded until this browser says otherwise. Read after mount, so the
    // server's markup and the first client render agree.
    const [open, setOpen] = useState<Set<string>>(() => new Set());
    useEffect(() => setOpen(readOpenGroups()), []);
    const groups = core.NOTIFICATION_GROUPS.filter((group) =>
        core.NOTIFICATION_EVENTS.some((entry) => entry.group === group)
    );

    function toggle(group: string) {
        setOpen((current) => {
            const next = new Set(current);
            if (next.has(group)) next.delete(group);
            else next.add(group);
            writeOpenGroups(next);
            return next;
        });
    }

    return (
        <div className="flex flex-col gap-2">
            {groups.map((group) => (
                <EventGroup
                    key={group}
                    group={group}
                    open={open.has(group)}
                    onToggle={() => toggle(group)}
                    state={state}
                    destinations={destinations}
                    onChange={onChange}
                    hold={hold}
                />
            ))}
        </div>
    );
}

export function EventGroup({
    group,
    open,
    onToggle,
    state,
    destinations,
    onChange,
    hold
}: {
    group: core.NotificationGroup;
    open: boolean;
    onToggle: () => void;
    state: Map<string, core.NotificationRule>;
    destinations: DestinationView[];
    onChange: (event: string, rule: core.NotificationRule) => void;
    hold: HoldControls;
}) {
    const t = useTranslations("accountNotifications");
    const events = core.NOTIFICATION_EVENTS.filter((entry) => entry.group === group);
    const { on, total } = groupSummary(events, state);
    const target: core.HoldTarget = { kind: "group", id: group };
    const label = groupLabel(t, group);
    const panelId = `notify-group-${group}`;

    return (
        <Card className="overflow-visible">
            <div className="flex items-center gap-1 pr-2">
                <button
                    type="button"
                    onClick={onToggle}
                    aria-expanded={open}
                    aria-controls={panelId}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left"
                >
                    <ChevronRight
                        className={cn(
                            "size-4 shrink-0 text-muted-foreground transition-transform",
                            open && "rotate-90"
                        )}
                        aria-hidden
                    />
                    <span className="truncate text-sm font-semibold" title={label}>
                        {label}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                        {t("holds.summary", { on, total })}
                    </span>
                </button>
                <HoldState target={target} hold={hold} compact />
                <HoldMenu target={target} name={label} hold={hold} />
            </div>
            {open ? (
                <ul id={panelId} className="divide-y divide-border border-t border-border">
                    {events.map((entry) => {
                        const rule = state.get(entry.id);
                        if (!rule) return null;
                        const name = eventLabel(t, entry.id) ?? entry.id;
                        const eventTarget: core.HoldTarget = { kind: "event", id: entry.id };
                        return (
                            <li
                                key={entry.id}
                                className="flex flex-col gap-1.5 px-3 py-2 sm:flex-row sm:items-center sm:gap-3"
                            >
                                <div className="min-w-0 sm:flex-1">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <p className="truncate text-sm font-medium" title={name}>
                                            {name}
                                        </p>
                                        {core.isMuted(rule) ? (
                                            <Badge>{t("rules.muted")}</Badge>
                                        ) : null}
                                    </div>
                                    <p
                                        className="truncate text-xs text-muted-foreground"
                                        title={eventDescription(t, entry.id)}
                                    >
                                        {eventDescription(t, entry.id)}
                                    </p>
                                    {entry.critical ? null : (
                                        <HoldState target={eventTarget} hold={hold} />
                                    )}
                                </div>
                                <div className="flex min-w-0 items-center gap-1">
                                    <RuleChips
                                        eventId={entry.id}
                                        rule={rule}
                                        critical={entry.critical === true}
                                        offBell={entry.offBell === true}
                                        destinations={destinations}
                                        onChange={onChange}
                                    />
                                    {entry.critical ? null : (
                                        <HoldMenu target={eventTarget} name={name} hold={hold} />
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            ) : null}
        </Card>
    );
}

/** "Muted until 14:00" and "Mon-Fri, 09:00-18:00", with the button that lifts
 *  each. Nothing when neither is set. */
function HoldState({
    target,
    hold,
    compact = false
}: {
    target: core.HoldTarget;
    hold: HoldControls;
    compact?: boolean;
}) {
    const t = useTranslations("accountNotifications");
    const format = useDisplayFormat();
    const locale = useLocale();
    const key = core.holdKey(target);
    const mute = hold.holds.mutes[key];
    const muted = core.muteActive(mute, new Date());
    const schedule = hold.holds.schedules[key];
    if (!muted && !schedule) return null;

    const untilLabel = (until: string) => {
        const at = new Date(until);
        return format.date(at) === format.date(new Date()) ? format.time(at) : format.dateTime(at);
    };
    const muteText = mute?.until
        ? t("holds.mutedUntil", { time: untilLabel(mute.until) })
        : t("holds.muted");
    const scheduleText = schedule
        ? describeSchedule(t, schedule, core.weekOrderFrom(format.weekStartsOn), locale)
        : "";

    if (compact) {
        const text = muted ? muteText : scheduleText;
        const Icon = muted ? BellOff : CalendarClock;
        return (
            <span className="flex min-w-0 shrink items-center gap-1.5 text-xs text-muted-foreground">
                <span className="flex min-w-0 items-center gap-1" title={text}>
                    <Icon className="size-3.5 shrink-0" aria-hidden />
                    <span className="hidden truncate sm:inline">{text}</span>
                    <span className="sr-only sm:hidden">{text}</span>
                </span>
                {muted ? (
                    <button
                        type="button"
                        onClick={() => hold.onMute(target, null)}
                        className="shrink-0 font-medium text-primary hover:underline"
                    >
                        {t("holds.unmute")}
                    </button>
                ) : null}
            </span>
        );
    }

    return (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {muted ? (
                <span className="flex min-w-0 items-center gap-1">
                    <BellOff className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate" title={muteText}>
                        {muteText}
                    </span>
                    <button
                        type="button"
                        onClick={() => hold.onMute(target, null)}
                        className="font-medium text-primary hover:underline"
                    >
                        {t("holds.unmute")}
                    </button>
                </span>
            ) : null}
            {schedule ? (
                <span className="flex min-w-0 items-center gap-1">
                    <CalendarClock className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate" title={scheduleText}>
                        {scheduleText}
                    </span>
                </span>
            ) : null}
        </div>
    );
}

/** The days and hours of a schedule in a line. */
export function describeSchedule(
    t: Translate,
    schedule: core.NotificationSchedule,
    weekOrder: readonly number[],
    locale: string
): string {
    const mask = schedule.days & core.EVERY_DAY;
    const days =
        mask === core.EVERY_DAY
            ? t("holds.everyDay")
            : mask === core.WEEKDAYS
              ? t("holds.weekdays")
              : mask === core.WEEKEND
                ? t("holds.weekends")
                : weekOrder
                      .filter((day) => core.runsOnDay(mask, day))
                      .map((day) => core.weekdayNames(locale, "short")[day])
                      .join(", ");
    const hours =
        schedule.startMinute === schedule.endMinute
            ? t("holds.allDay")
            : t("holds.hours", {
                  from: core.clockTime(schedule.startMinute),
                  to: core.clockTime(schedule.endMinute)
              });
    return `${days}, ${hours}`;
}

/** Mute for a while, unmute, and set or clear hours, for an event or a group. */
function HoldMenu({
    target,
    name,
    hold
}: {
    target: core.HoldTarget;
    name: string;
    hold: HoldControls;
}) {
    const t = useTranslations("accountNotifications");
    const [editing, setEditing] = useState(false);
    const key = core.holdKey(target);
    const muted = core.muteActive(hold.holds.mutes[key], new Date());
    const schedule = hold.holds.schedules[key];

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0"
                        aria-label={t("holds.options", { name })}
                        title={t("holds.options", { name })}
                    >
                        <MoreHorizontal className="size-4" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    {muted ? (
                        <DropdownMenuItem onSelect={() => hold.onMute(target, null)}>
                            <Bell />
                            {t("holds.unmute")}
                        </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuLabel>{t("holds.muteFor")}</DropdownMenuLabel>
                    {core.NOTIFICATION_MUTE_DURATIONS.map((duration) => (
                        <DropdownMenuItem
                            key={duration}
                            onSelect={() => hold.onMute(target, duration)}
                        >
                            <BellOff />
                            {t(`holds.durations.${duration}`)}
                        </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setEditing(true)}>
                        <CalendarClock />
                        {schedule ? t("holds.editSchedule") : t("holds.setSchedule")}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            {/* Mounted only while open, so it starts from what is saved each time. */}
            {editing ? (
                <ScheduleDialog
                    open
                    onOpenChange={setEditing}
                    name={name}
                    initial={schedule ?? null}
                    timeZone={hold.timeZone}
                    onSave={(next) => {
                        hold.onSchedule(target, next);
                        setEditing(false);
                    }}
                />
            ) : null}
        </>
    );
}

/** Office hours, Monday to Friday: what almost everybody sets first. */
const DEFAULT_SCHEDULE: core.NotificationSchedule = {
    days: core.WEEKDAYS,
    startMinute: 9 * 60,
    endMinute: 18 * 60
};

function ScheduleDialog({
    open,
    onOpenChange,
    name,
    initial,
    timeZone,
    onSave
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    name: string;
    initial: core.NotificationSchedule | null;
    timeZone: string;
    onSave: (schedule: core.NotificationSchedule | null) => void;
}) {
    const t = useTranslations("accountNotifications");
    const start = initial ?? DEFAULT_SCHEDULE;
    const [days, setDays] = useState(start.days);
    const [from, setFrom] = useState(core.clockTime(start.startMinute));
    const [to, setTo] = useState(core.clockTime(start.endMinute));

    const checked = useMemo(
        () =>
            core.notificationScheduleSchema.safeParse({
                days,
                startMinute: core.clockMinute(from),
                endMinute: core.clockMinute(to)
            }),
        [days, from, to]
    );
    const problem = days === 0 ? t("holds.needDays") : !checked.success ? t("quiet.invalid") : null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("holds.scheduleTitle", { name })}</DialogTitle>
                    <DialogDescription>
                        {t("holds.scheduleHint", { zone: timeZone })}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <WeekdayPicker legend={t("holds.days")} days={days} onChange={setDays} />
                    <div className="grid grid-cols-2 gap-3">
                        <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                            {t("quiet.from")}
                            <Input
                                type="time"
                                value={from}
                                onChange={(e) => setFrom(e.target.value)}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                            {t("quiet.until")}
                            <Input type="time" value={to} onChange={(e) => setTo(e.target.value)} />
                        </label>
                    </div>
                    {problem ? <p className="text-xs text-danger">{problem}</p> : null}
                    <div className="flex flex-wrap justify-end gap-2">
                        {initial ? (
                            <Button
                                variant="ghost"
                                className="mr-auto"
                                onClick={() => onSave(null)}
                            >
                                {t("holds.removeSchedule")}
                            </Button>
                        ) : null}
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            {t("holds.cancel")}
                        </Button>
                        <Button
                            disabled={!checked.success}
                            onClick={() => checked.success && onSave(checked.data)}
                        >
                            {t("quiet.save")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** The delivery toggles for one event, as chips that read as on or off. */
function RuleChips({
    eventId,
    rule,
    critical,
    offBell,
    destinations,
    onChange
}: {
    eventId: string;
    rule: core.NotificationRule;
    critical: boolean;
    offBell: boolean;
    destinations: DestinationView[];
    onChange: (event: string, rule: core.NotificationRule) => void;
}) {
    const t = useTranslations("accountNotifications");

    function toggleDestination(id: string) {
        const on = rule.destinations.includes(id);
        onChange(eventId, {
            ...rule,
            destinations: on
                ? rule.destinations.filter((entry) => entry !== id)
                : [...rule.destinations, id]
        });
    }

    return (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 sm:justify-end">
            <Chip
                icon={Bell}
                label={t("rules.inApp")}
                on={rule.inapp}
                // A security alert always leaves a record; only where else it goes
                // is negotiable.
                // And one whose own screen already carries it never does.
                disabled={critical || offBell}
                title={
                    critical
                        ? t("rules.securityAlways")
                        : offBell
                          ? t("rules.shownOnItsScreen")
                          : undefined
                }
                onClick={() => onChange(eventId, { ...rule, inapp: !rule.inapp })}
            />
            <Chip
                icon={Mail}
                label={t("rules.email")}
                on={rule.email}
                onClick={() => onChange(eventId, { ...rule, email: !rule.email })}
            />
            {destinations.map((destination) => (
                <Chip
                    key={destination.id}
                    icon={destination.kind === "sms" ? Smartphone : Webhook}
                    label={destination.name}
                    on={rule.destinations.includes(destination.id)}
                    disabled={!destination.enabled}
                    title={destination.enabled ? destination.targetHint : t("rules.destinationOff")}
                    onClick={() => toggleDestination(destination.id)}
                />
            ))}
        </div>
    );
}

function Chip({
    icon: Icon,
    label,
    on,
    disabled,
    title,
    onClick
}: {
    icon: typeof Webhook;
    label: string;
    on: boolean;
    disabled?: boolean;
    title?: string;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={title ?? label}
            aria-pressed={on}
            className={cn(
                "inline-flex max-w-48 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors",
                on
                    ? "border-transparent bg-primary/15 text-primary"
                    : "border-border bg-muted text-muted-foreground hover:text-foreground",
                disabled && "cursor-not-allowed opacity-60 hover:text-muted-foreground"
            )}
        >
            <Icon className="size-3 shrink-0" />
            <span className="truncate" title={label}>
                {label}
            </span>
        </button>
    );
}
