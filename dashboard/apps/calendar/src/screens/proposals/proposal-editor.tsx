"use client";

/**
 * Writing a meeting proposal: what it is, how long, the people asked (Polaris
 * people picked from the directory, or any address typed) and the candidate
 * times. Checked as it is typed against the schema the server checks again.
 */

import * as engine from "../../engine";
import { useCalendarT } from "../i18n";
import { unwrap } from "../cached-read";
import { useMemo, useState } from "react";
import { ZonePicker } from "../zone-picker";
import { Plus, Trash2 } from "lucide-react";
import { browserZone, wallOf } from "../time";
import { FieldRow, GroupHeading } from "../ui";
import { hostUi } from "@polaris/app-host/client";
import { StatusNote, useIssueText } from "../public/kit";
import * as proposalActions from "../../actions/proposals";
import type { ProposalView } from "../../lib/scheduling-wire";
import { Button, Input, Select, Switch, Textarea } from "@polaris/ui";
import { emailSchema, proposalInputSchema } from "../../lib/scheduling-schemas";

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

interface Draft {
    title: string;
    description: string;
    location: string;
    durationMinutes: number;
    timezone: string;
    notify: boolean;
    participants: { email: string; name: string; required: boolean }[];
    /** Wall times in the proposal's zone, `YYYY-MM-DDTHH:mm`. */
    dates: string[];
}

function draftOf(proposal: ProposalView | null): Draft {
    const zone = proposal?.timezone || browserZone();
    return {
        title: proposal?.title ?? "",
        description: proposal?.description ?? "",
        location: proposal?.location ?? "",
        durationMinutes: proposal?.durationMinutes ?? 60,
        timezone: zone,
        notify: proposal?.notify ?? true,
        participants:
            proposal?.participants.map((entry) => ({
                email: entry.email,
                name: entry.name,
                required: entry.required
            })) ?? [],
        dates: proposal?.dates.map((date) => wallOf(date.start, zone).slice(0, 16)) ?? [""]
    };
}

/** A wall time in a zone as an ISO instant, or the text as typed when it is not one. */
function instantOf(wall: string, zone: string): string {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(wall) || !engine.resolveZone(zone)) return wall;
    return engine.wallToInstant(engine.parseWall(`${wall}:00`), zone).toISOString();
}

export function ProposalEditor({
    proposal,
    onSaved,
    onCancel
}: {
    proposal: ProposalView | null;
    onSaved: (proposal: ProposalView) => void;
    onCancel?: () => void;
}) {
    const t = useCalendarT();
    const issueText = useIssueText();
    const AccountInput = hostUi.accountInput.AccountInput;
    const [draft, setDraft] = useState<Draft>(() => draftOf(proposal));
    const [typed, setTyped] = useState("");
    const [problem, setProblem] = useState<string | null>(null);
    const [addProblem, setAddProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const initial = useMemo(() => JSON.stringify(draftOf(proposal)), [proposal]);
    const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
        setDraft((current) => ({ ...current, [key]: value }));

    const filledDates = draft.dates.filter((date) => date.trim() !== "");
    const input = { ...draft, dates: filledDates.map((date) => instantOf(date, draft.timezone)) };
    const parsed = proposalInputSchema.safeParse(input);
    const dirty = JSON.stringify(draft) !== initial;
    const issueFor = (field: string) => {
        if (parsed.success) return null;
        const issues = parsed.error.issues.filter((issue) => issue.path[0] === field);
        return issues.length > 0 ? issueText(issues) : null;
    };
    const titleMissing = draft.title.trim() === "";

    const addPerson = (email: string, name: string) => {
        setAddProblem(null);
        const checked = emailSchema.safeParse(email);
        if (!checked.success) {
            setAddProblem(
                email.trim() ? issueText(checked.error.issues) : t("proposals.addressHidden")
            );
            return false;
        }
        if (draft.participants.some((entry) => entry.email === checked.data)) return true;
        set("participants", [
            ...draft.participants,
            { email: checked.data, name: name.trim(), required: true }
        ]);
        return true;
    };

    const save = async () => {
        if (!parsed.success || !dirty || busy) return;
        setBusy(true);
        setProblem(null);
        try {
            const answer = await unwrap(
                () =>
                    proposal
                        ? proposalActions.updateProposalAction(proposal.id, parsed.data)
                        : proposalActions.createProposalAction(parsed.data),
                t("proposals.failed")
            );
            onSaved(answer.proposal);
        } catch (caught) {
            setProblem(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
                event.preventDefault();
                void save();
            }}
        >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FieldRow
                    className="sm:col-span-2"
                    label={`${t("proposals.fieldTitle")} *`}
                    htmlFor="proposal-title"
                    error={titleMissing ? null : issueFor("title")}
                >
                    <Input
                        id="proposal-title"
                        value={draft.title}
                        onChange={(event) => set("title", event.target.value)}
                        autoFocus={!proposal}
                    />
                </FieldRow>
                <FieldRow
                    label={t("proposals.fieldLocation")}
                    htmlFor="proposal-location"
                    error={issueFor("location")}
                >
                    <Input
                        id="proposal-location"
                        value={draft.location}
                        onChange={(event) => set("location", event.target.value)}
                    />
                </FieldRow>
                <FieldRow label={t("proposals.fieldDuration")} htmlFor="proposal-duration">
                    <Select
                        id="proposal-duration"
                        value={String(draft.durationMinutes)}
                        onValueChange={(value) => set("durationMinutes", Number(value))}
                        options={DURATIONS.map((minutes) => ({
                            value: String(minutes),
                            label: t("proposals.minutes", { count: minutes })
                        }))}
                    />
                </FieldRow>
                <FieldRow
                    className="sm:col-span-2"
                    label={t("proposals.fieldDescription")}
                    htmlFor="proposal-description"
                    error={issueFor("description")}
                >
                    <Textarea
                        id="proposal-description"
                        rows={3}
                        value={draft.description}
                        onChange={(event) => set("description", event.target.value)}
                    />
                </FieldRow>
            </div>

            <section className="flex flex-col gap-2">
                <GroupHeading>{t("proposals.people")}</GroupHeading>
                <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1">
                        <AccountInput
                            value={typed}
                            onValueChange={setTyped}
                            onPick={(account) => {
                                if (addPerson(account.email, account.name)) setTyped("");
                            }}
                            onEnter={() => {
                                if (addPerson(typed, "")) setTyped("");
                            }}
                            placeholder={t("proposals.addPlaceholder")}
                            aria-label={t("proposals.addPerson")}
                        />
                    </div>
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={typed.trim() === ""}
                        onClick={() => {
                            if (addPerson(typed, "")) setTyped("");
                        }}
                    >
                        {t("proposals.add")}
                    </Button>
                </div>
                {addProblem ? (
                    <p role="alert" className="text-xs text-danger">
                        {addProblem}
                    </p>
                ) : null}
                {draft.participants.length === 0 ? (
                    <p className="text-xs text-foreground-subtle">{t("proposals.noPeopleYet")}</p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                        {draft.participants.map((person, index) => (
                            <li key={person.email} className="flex items-center gap-2 px-3 py-1.5">
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-[13px]" title={person.email}>
                                        {person.name || person.email}
                                    </div>
                                    {person.name ? (
                                        <div className="truncate text-xs text-foreground-subtle">
                                            {person.email}
                                        </div>
                                    ) : null}
                                </div>
                                <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                                    <Switch
                                        checked={person.required}
                                        onChange={(required) =>
                                            set(
                                                "participants",
                                                draft.participants.map((entry, at) =>
                                                    at === index ? { ...entry, required } : entry
                                                )
                                            )
                                        }
                                        aria-label={t("proposals.requiredFor", {
                                            name: person.name || person.email
                                        })}
                                    />
                                    <span className="hidden sm:inline">
                                        {person.required
                                            ? t("proposals.required")
                                            : t("proposals.optional")}
                                    </span>
                                </label>
                                <Button
                                    type="button"
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label={t("proposals.removePerson", {
                                        name: person.name || person.email
                                    })}
                                    title={t("proposals.removePerson", {
                                        name: person.name || person.email
                                    })}
                                    onClick={() =>
                                        set(
                                            "participants",
                                            draft.participants.filter((_, at) => at !== index)
                                        )
                                    }
                                >
                                    <Trash2 />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
                {draft.participants.length > 0 && issueFor("participants") ? (
                    <p role="alert" className="text-xs text-danger">
                        {issueFor("participants")}
                    </p>
                ) : null}
            </section>

            <section className="flex flex-col gap-2">
                <GroupHeading>{t("proposals.dates")}</GroupHeading>
                <FieldRow label={t("proposals.fieldZone")}>
                    <ZonePicker
                        value={draft.timezone}
                        onChange={(zone) => set("timezone", zone)}
                        label={t("proposals.fieldZone")}
                    />
                </FieldRow>
                <ul className="flex flex-col gap-1.5">
                    {draft.dates.map((date, index) => (
                        <li key={index} className="flex items-center gap-2">
                            <Input
                                type="datetime-local"
                                value={date}
                                onChange={(event) =>
                                    set(
                                        "dates",
                                        draft.dates.map((entry, at) =>
                                            at === index ? event.target.value : entry
                                        )
                                    )
                                }
                                aria-label={t("proposals.dateNumber", { number: index + 1 })}
                                className="max-w-xs"
                            />
                            <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                disabled={draft.dates.length <= 1}
                                aria-label={t("proposals.removeDate", { number: index + 1 })}
                                title={t("proposals.removeDate", { number: index + 1 })}
                                onClick={() =>
                                    set(
                                        "dates",
                                        draft.dates.filter((_, at) => at !== index)
                                    )
                                }
                            >
                                <Trash2 />
                            </Button>
                        </li>
                    ))}
                </ul>
                <div>
                    <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={draft.dates.length >= 30}
                        onClick={() => set("dates", [...draft.dates, draft.dates.at(-1) ?? ""])}
                    >
                        <Plus />
                        {t("proposals.addDate")}
                    </Button>
                </div>
                {filledDates.length > 0 && issueFor("dates") ? (
                    <p role="alert" className="text-xs text-danger">
                        {issueFor("dates")}
                    </p>
                ) : null}
            </section>

            <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Switch
                    checked={draft.notify}
                    onChange={(notify) => set("notify", notify)}
                    aria-label={t("proposals.notify")}
                />
                {t("proposals.notify")}
            </label>

            {problem ? <StatusNote tone="danger">{problem}</StatusNote> : null}
            <div className="flex justify-end gap-2">
                {onCancel ? (
                    <Button type="button" variant="ghost" onClick={onCancel}>
                        {t("proposals.cancel")}
                    </Button>
                ) : null}
                <Button
                    type="submit"
                    disabled={busy}
                    aria-disabled={!parsed.success || !dirty || busy}
                >
                    {proposal ? t("proposals.save") : t("proposals.create")}
                </Button>
            </div>
        </form>
    );
}
