"use client";

/**
 * Who is invited: Polaris people picked from the directory or any address
 * typed, each with a role and whether an answer is asked for, and how they
 * answered. The organizer line, the counts, and "copy / email everybody" sit
 * above the list, the way Nextcloud draws them.
 */

import { useState } from "react";
import * as engine from "../engine";
import { useCalendarT } from "./i18n";
import { calendarSlots } from "./slots";
import { hostUi } from "@polaris/app-host/client";
import { Button, Select, Switch } from "@polaris/ui";
import { responseCounts, type AttendeeDraft } from "./editor-model";
import { Check, CircleHelp, Clock, DoorOpen, Mail, UsersRound, X } from "lucide-react";

const ROLES: readonly engine.AttendeeRole[] = [
    "REQ-PARTICIPANT",
    "OPT-PARTICIPANT",
    "CHAIR",
    "NON-PARTICIPANT"
];

function PartstatIcon({ partstat, label }: { partstat: engine.PartStat; label: string }) {
    const icon =
        partstat === "ACCEPTED" ? (
            <Check className="size-4 text-success" />
        ) : partstat === "DECLINED" ? (
            <X className="size-4 text-danger" />
        ) : partstat === "TENTATIVE" ? (
            <CircleHelp className="size-4 text-warning" />
        ) : (
            <Clock className="size-4 text-foreground-subtle" />
        );
    return (
        <span role="img" aria-label={label} title={label} className="inline-flex shrink-0">
            {icon}
        </span>
    );
}

export function AttendeesEditor({
    value,
    onChange,
    readOnly,
    organizer,
    when
}: {
    value: readonly AttendeeDraft[];
    onChange: (attendees: AttendeeDraft[]) => void;
    readOnly: boolean;
    organizer: engine.Person | null;
    /** The event's time, for "find a time" and the room picker. */
    when: {
        start: string;
        end: string;
        zone: string;
        onPick: (start: string, end: string) => void;
    } | null;
}) {
    const t = useCalendarT();
    const [typed, setTyped] = useState("");
    const [problem, setProblem] = useState<string | null>(null);
    const [findOpen, setFindOpen] = useState(false);
    const [roomOpen, setRoomOpen] = useState(false);
    const AccountInput = hostUi.accountInput.AccountInput;
    const FindATime = calendarSlots.FindATime;
    const RoomPicker = calendarSlots.RoomPicker;

    const add = (
        entries: readonly { email: string; name: string; type?: engine.CalendarUserType }[]
    ) => {
        const next = [...value];
        for (const entry of entries) {
            const parsed = engine.attendeeSchema.safeParse({
                email: entry.email,
                name: entry.name,
                type: entry.type ?? "INDIVIDUAL"
            });
            if (!parsed.success) {
                setProblem(t("attendeeEditor.badAddress", { address: entry.email }));
                return;
            }
            if (next.some((attendee) => attendee.email === parsed.data.email)) continue;
            next.push(parsed.data);
        }
        setProblem(null);
        setTyped("");
        onChange(next);
    };

    const addTyped = () => {
        const addresses = typed
            .split(/[,;\s]+/)
            .map((part) => part.trim())
            .filter(Boolean);
        if (addresses.length > 0) add(addresses.map((email) => ({ email, name: "" })));
    };

    const counts = responseCounts(value);
    const emails = value.map((attendee) => attendee.email);
    const update = (email: string, change: Partial<AttendeeDraft>) =>
        onChange(
            value.map((attendee) =>
                attendee.email === email ? { ...attendee, ...change } : attendee
            )
        );

    return (
        <div className="flex flex-col gap-2">
            {organizer ? (
                <p className="text-xs text-muted-foreground">
                    {t("attendeeEditor.organizer", { name: organizer.name || organizer.email })}
                </p>
            ) : null}

            {value.length > 0 ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
                    <span>
                        {t("attendeeEditor.counts", {
                            accepted: counts.ACCEPTED,
                            tentative: counts.TENTATIVE,
                            declined: counts.DECLINED,
                            waiting: counts["NEEDS-ACTION"]
                        })}
                    </span>
                    <span className="flex items-center gap-1">
                        <hostUi.copyButton.CopyButton
                            value={emails.join(", ")}
                            label={t("attendeeEditor.copyAll")}
                        />
                        <Button asChild size="icon-sm" variant="ghost">
                            <a
                                href={`mailto:${emails.map(encodeURIComponent).join(",")}`}
                                aria-label={t("attendeeEditor.emailAll")}
                                title={t("attendeeEditor.emailAll")}
                            >
                                <Mail />
                            </a>
                        </Button>
                    </span>
                </div>
            ) : null}

            <ul className="flex flex-col gap-1">
                {value.map((attendee) => {
                    const answer = t(`attendeeEditor.partstat.${attendee.partstat}`);
                    const name = attendee.name || attendee.email;
                    return (
                        <li
                            key={attendee.email}
                            className="flex min-w-0 flex-wrap items-center gap-2 rounded-md px-1 py-1 hover:bg-card-hover sm:flex-nowrap"
                        >
                            <PartstatIcon partstat={attendee.partstat} label={answer} />
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-[0.8125rem]" title={name}>
                                    {name}
                                </span>
                                {attendee.name ? (
                                    <span
                                        className="block truncate text-xs text-foreground-subtle"
                                        title={attendee.email}
                                    >
                                        {attendee.email}
                                    </span>
                                ) : null}
                            </span>
                            {readOnly ? (
                                <span className="text-xs text-muted-foreground">
                                    {t(`attendeeEditor.role.${attendee.role}`)}
                                </span>
                            ) : (
                                <>
                                    <Select
                                        className="w-36"
                                        aria-label={t("attendeeEditor.roleFor", { name })}
                                        value={attendee.role}
                                        onValueChange={(role) =>
                                            update(attendee.email, {
                                                role: role as engine.AttendeeRole
                                            })
                                        }
                                        options={ROLES.map((role) => ({
                                            value: role,
                                            label: t(`attendeeEditor.role.${role}`)
                                        }))}
                                    />
                                    <span
                                        className="flex items-center gap-1.5 text-xs text-muted-foreground"
                                        title={t("attendeeEditor.rsvp")}
                                    >
                                        <Switch
                                            checked={attendee.rsvp}
                                            onChange={(rsvp) => update(attendee.email, { rsvp })}
                                            aria-label={t("attendeeEditor.rsvpFor", { name })}
                                        />
                                    </span>
                                    <Button
                                        size="icon-sm"
                                        variant="ghost"
                                        aria-label={t("attendeeEditor.remove", { name })}
                                        title={t("attendeeEditor.remove", { name })}
                                        onClick={() =>
                                            onChange(
                                                value.filter(
                                                    (entry) => entry.email !== attendee.email
                                                )
                                            )
                                        }
                                    >
                                        <X />
                                    </Button>
                                </>
                            )}
                        </li>
                    );
                })}
            </ul>

            {!readOnly ? (
                <div className="flex flex-col gap-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <div className="min-w-0 flex-1">
                            <AccountInput
                                value={typed}
                                onValueChange={setTyped}
                                onPick={(account) =>
                                    add([{ email: account.email, name: account.name }])
                                }
                                onEnter={addTyped}
                                placeholder={t("attendeeEditor.placeholder")}
                                aria-label={t("attendeeEditor.add")}
                            />
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={addTyped}
                            disabled={typed.trim() === ""}
                        >
                            {t("attendeeEditor.addButton")}
                        </Button>
                        {FindATime && when ? (
                            <Button size="sm" variant="ghost" onClick={() => setFindOpen(true)}>
                                <UsersRound />
                                {t("attendeeEditor.findATime")}
                            </Button>
                        ) : null}
                        {RoomPicker && when ? (
                            <Button size="sm" variant="ghost" onClick={() => setRoomOpen(true)}>
                                <DoorOpen />
                                {t("attendeeEditor.room")}
                            </Button>
                        ) : null}
                    </div>
                    {problem ? (
                        <p role="alert" className="text-xs text-danger">
                            {problem}
                        </p>
                    ) : null}
                </div>
            ) : null}

            {FindATime && when ? (
                <FindATime
                    open={findOpen}
                    onOpenChange={setFindOpen}
                    attendees={[...(organizer ? [organizer.email] : []), ...emails]}
                    start={when.start}
                    end={when.end}
                    zone={when.zone}
                    onPick={(start, end) => {
                        when.onPick(start, end);
                        setFindOpen(false);
                    }}
                />
            ) : null}
            {RoomPicker && when ? (
                <RoomPicker
                    open={roomOpen}
                    onOpenChange={setRoomOpen}
                    start={when.start}
                    end={when.end}
                    zone={when.zone}
                    onPick={(room) => {
                        add([{ email: room.email, name: room.name, type: room.type }]);
                        setRoomOpen(false);
                    }}
                />
            ) : null}
        </div>
    );
}
