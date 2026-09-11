"use client";

/**
 * Handing one thing over, from wherever it is being handed over.
 *
 * One dialog for a conversation, a space and a front door, because it is one
 * question with one shape: who, what may they do, and - for the things where it
 * means anything - when. A door lent to a visitor is the case that needs the
 * hours and the count; a conversation handed to the support team is the case
 * that must not be asked about them, so the whole "only sometimes" half of the
 * form is absent rather than empty for it.
 *
 * What is already shared is the top of the dialog rather than a second screen.
 * Taking a key back is the urgent thing somebody comes here to do, and it should
 * never be more than opening this and pressing once.
 */

import * as core from "@polaris/core";
import type { GrantView } from "@/lib/access/grants";
import { useConfirm } from "@/components/confirm-dialog";
import { useDisplayFormat } from "@/components/display-format";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { GrantCandidate } from "@/lib/access/sharing-service";
import { CalendarClock, Loader2, Search, Trash2, UserRound, Users } from "lucide-react";
import {
    findSharePeopleAction,
    listGrantsAction,
    revokeShareAction,
    shareAction
} from "@/app/(app)/access-actions";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Select,
    Skeleton,
    Switch,
    cn,
    useToast
} from "@polaris/ui";

/** How each capability reads. The same words the server uses, since a screen
 *  that renames them is a screen whose refusals name something else. */
const CAPABILITY_WORDS: Record<string, { label: string; hint: string }> = {
    guest: { label: "Guest", hint: "Read it, and comment where they are involved." },
    member: { label: "Member", hint: "Take part: post, create and edit." },
    admin: { label: "Admin", hint: "Everything a member can do, plus running it." },
    view: { label: "Can see", hint: "Watch it and see its state. Nothing else." },
    control: { label: "Can operate", hint: "Open, close and switch it, as well as see it." }
};

/** What a standing looks like beside a row. Only `live` is quiet: the other four
 *  are the reason somebody is looking. */
const STANDING_TONE: Record<core.GrantStanding, "success" | "warning" | "neutral"> = {
    live: "success",
    waiting: "neutral",
    expired: "neutral",
    closed: "warning",
    spent: "neutral"
};

export function ShareDialog({
    open,
    onOpenChange,
    subject,
    subjectId,
    name,
    bounded = false,
    extra
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    subject: core.GrantSubject;
    subjectId: string;
    /** What is being shared, in the words on the screen behind this. */
    name: string;
    /** Whether hours, dates and a number of uses mean anything here. They do for
     *  a door and a camera; they do not for a conversation. */
    bounded?: boolean;
    /**
     * Anything the thing being shared has of its own, under the grants.
     *
     * Office fills it with the links a document is handed out on. A slot rather
     * than a branch here, because this dialog is chat's and tasks' and Places'
     * as well, and it has no business knowing what a document is.
     */
    extra?: ReactNode;
}) {
    const toast = useToast();
    const format = useDisplayFormat();
    // The reader's own week, so Monday-first and Sunday-first both draw the days
    // in the order the person expects to read them in.
    const weekOrder = useMemo(() => core.weekOrderFrom(format.weekStartsOn), [format.weekStartsOn]);
    const [grants, setGrants] = useState<GrantView[] | null>(null);
    const [candidates, setCandidates] = useState<GrantCandidate[]>([]);
    const [busy, setBusy] = useState(false);
    const [confirm, confirmDialog] = useConfirm();

    const capabilities = core.GRANT_CAPABILITIES[subject] as readonly string[];
    // The weakest by default, everywhere. Sharing is a thing people do quickly,
    // and the cost of the default being too generous is somebody having more of
    // your house than you meant.
    const [capability, setCapability] = useState(capabilities[0] ?? "");
    const [kind, setKind] = useState<core.GrantPrincipal>("user");
    const [principalId, setPrincipalId] = useState("");
    const [query, setQuery] = useState("");
    const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
    const [note, setNote] = useState("");
    const [limited, setLimited] = useState(false);
    const [startsAt, setStartsAt] = useState("");
    const [endsAt, setEndsAt] = useState("");
    const [days, setDays] = useState(core.EVERY_DAY);
    const [hours, setHours] = useState({ from: "", to: "" });
    const [maxUses, setMaxUses] = useState("");

    const load = useCallback(async () => {
        const answer = await listGrantsAction(subject, subjectId);
        if (answer.error) {
            toast.show({ title: answer.error });
            setGrants([]);
            return;
        }
        setGrants(answer.grants ?? []);
        setCandidates(answer.candidates ?? []);
    }, [subject, subjectId, toast]);

    useEffect(() => {
        if (!open) return;
        setGrants(null);
        void load();
    }, [open, load]);

    // Looked up as they type, after a beat: a search on every keystroke is a
    // query per letter, and the answer to "ma" is not worth the round trip.
    useEffect(() => {
        if (kind !== "user" || query.trim().length < 2) {
            setPeople([]);
            return;
        }
        const timer = setTimeout(async () => {
            const found = await findSharePeopleAction(subject, subjectId, query);
            setPeople(found.people ?? []);
        }, 250);
        return () => clearTimeout(timer);
    }, [kind, query, subject, subjectId]);

    const groups = useMemo(() => candidates.filter((one) => one.type === kind), [candidates, kind]);

    const reset = (): void => {
        setPrincipalId("");
        setQuery("");
        setPeople([]);
        setNote("");
        setLimited(false);
        setStartsAt("");
        setEndsAt("");
        setDays(core.EVERY_DAY);
        setHours({ from: "", to: "" });
        setMaxUses("");
    };

    const add = async (): Promise<void> => {
        if (!principalId) return;
        setBusy(true);
        const answer = await shareAction(subject, subjectId, {
            principalType: kind,
            principalId,
            capability,
            note,
            ...(limited
                ? {
                      // The picked day, in the reader's own zone, and the last
                      // one lent whole: sent as a bare date these are both
                      // midnight UTC, which begins a grant early and ends it a
                      // day short.
                      startsAt: core.dayBegins(startsAt)?.toISOString(),
                      endsAt: core.dayEnds(endsAt)?.toISOString(),
                      days,
                      startMinute: core.clockMinute(hours.from),
                      endMinute: core.clockMinute(hours.to),
                      maxUses: maxUses ? Number(maxUses) : null
                  }
                : {})
        });
        setBusy(false);
        if (answer.error) {
            toast.show({ title: answer.error });
            return;
        }
        setGrants(answer.grants ?? []);
        reset();
        toast.show({ title: "Shared" });
    };

    /**
     * Taking somebody's access back.
     *
     * Asked first, because the bin icon sits on a row of people and the one
     * above the one somebody meant is somebody who then cannot open the thing
     * at all. The row goes on the answer to the question, not on the server's:
     * a refusal puts it back and says why.
     */
    const revoke = async (grant: GrantView): Promise<void> => {
        const sure = await confirm({
            title: `Stop sharing with ${grant.principalName}?`,
            description: `${grant.principalName} loses access to ${name} at once. You can share it again afterwards.`,
            confirmLabel: "Stop sharing",
            danger: true
        });
        if (!sure) return;
        const before = grants;
        setGrants((held) => (held ?? []).filter((one) => one.id !== grant.id));
        const answer = await revokeShareAction(subject, subjectId, grant.id);
        if (answer.error) {
            setGrants(before);
            toast.show({ title: answer.error });
            return;
        }
        setGrants(answer.grants ?? []);
        toast.show({ title: "Taken back" });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {/* Wider than the default, and deliberately: the form is two columns
                of times on a laptop and one on a phone, and at the default width
                it is one column of fourteen rows. */}
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>Share {name}</DialogTitle>
                    <DialogDescription>
                        {bounded
                            ? "Give somebody access without giving them the rest. You can limit it to certain days, hours and a number of uses."
                            : "Give a person, a team or a role access to this without adding them one at a time."}
                    </DialogDescription>
                </DialogHeader>

                <section className="flex flex-col gap-2" aria-label="Already shared with">
                    {grants === null ? (
                        <>
                            <Skeleton className="h-12 w-full" />
                            <Skeleton className="h-12 w-full" />
                        </>
                    ) : grants.length === 0 ? (
                        <p className="text-[13px] text-muted-foreground">
                            Not shared with anybody yet.
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-1">
                            {grants.map((grant) => (
                                <li
                                    key={grant.id}
                                    className="flex items-start gap-2 rounded-lg border border-border px-3 py-2"
                                >
                                    <span className="mt-0.5 text-foreground-subtle">
                                        {grant.principalType === "user" ? (
                                            <UserRound className="size-4 shrink-0" aria-hidden />
                                        ) : (
                                            <Users className="size-4 shrink-0" aria-hidden />
                                        )}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <p className="flex flex-wrap items-center gap-2 text-[13px] text-foreground">
                                            <span className="truncate font-medium">
                                                {grant.principalName}
                                            </span>
                                            {grant.orgName ? (
                                                <span className="text-foreground-subtle">
                                                    {grant.orgName}
                                                </span>
                                            ) : null}
                                            <Badge variant={STANDING_TONE[grant.standing]}>
                                                {core.GRANT_STANDING_LABELS[grant.standing]}
                                            </Badge>
                                        </p>
                                        <p className="text-[12px] text-muted-foreground">
                                            {CAPABILITY_WORDS[grant.capability]?.label ??
                                                grant.capability}
                                            {describe(grant, weekOrder) ? (
                                                <> - {describe(grant, weekOrder)}</>
                                            ) : null}
                                        </p>
                                        {grant.note ? (
                                            <p className="truncate text-[12px] text-foreground-subtle">
                                                {grant.note}
                                            </p>
                                        ) : null}
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Stop sharing with ${grant.principalName}`}
                                        title={`Stop sharing with ${grant.principalName}`}
                                        onClick={() => void revoke(grant)}
                                    >
                                        <Trash2 className="size-4 shrink-0" aria-hidden />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                <section
                    className="flex flex-col gap-3 border-t border-border pt-4"
                    aria-label="Share with somebody else"
                >
                    <SegmentedControl
                        aria-label="Who to share with"
                        size="sm"
                        value={kind}
                        onValueChange={(next) => {
                            setKind(next);
                            setPrincipalId("");
                        }}
                        options={[
                            { value: "user", label: "A person" },
                            {
                                value: "team",
                                label: "A team",
                                disabled: !candidates.some((one) => one.type === "team"),
                                title: "A team of one of your organizations"
                            },
                            {
                                value: "role",
                                label: "A role",
                                disabled: !candidates.some((one) => one.type === "role"),
                                title: "Everybody holding a role in one of your organizations"
                            }
                        ]}
                    />

                    {kind === "user" ? (
                        <div className="flex flex-col gap-1">
                            <label
                                className="text-[12px] text-muted-foreground"
                                htmlFor="share-who"
                            >
                                Search for somebody
                            </label>
                            <div className="relative">
                                <Search
                                    className="pointer-events-none absolute left-2 top-1/2 size-4 shrink-0 -translate-y-1/2 text-foreground-subtle"
                                    aria-hidden
                                />
                                <Input
                                    id="share-who"
                                    className="pl-8"
                                    value={query}
                                    placeholder="Name, username or address"
                                    onChange={(event) => setQuery(event.target.value)}
                                />
                            </div>
                            {people.length > 0 ? (
                                <ul className="flex flex-col gap-0.5">
                                    {people.map((person) => (
                                        <li key={person.id}>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setPrincipalId(person.id);
                                                    setQuery(person.name);
                                                    setPeople([]);
                                                }}
                                                className={cn(
                                                    "w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-hover",
                                                    principalId === person.id && "bg-surface-hover"
                                                )}
                                            >
                                                {person.name}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            ) : null}
                        </div>
                    ) : (
                        <Select
                            aria-label={kind === "team" ? "Which team" : "Which role"}
                            value={principalId}
                            onValueChange={setPrincipalId}
                            placeholder={kind === "team" ? "Pick a team" : "Pick a role"}
                            options={groups.map((one) => ({
                                value: one.id,
                                label: one.orgName ? `${one.orgName} - ${one.name}` : one.name
                            }))}
                        />
                    )}

                    <div className="flex flex-col gap-1">
                        <label className="text-[12px] text-muted-foreground" htmlFor="share-what">
                            What they can do
                        </label>
                        <Select
                            id="share-what"
                            aria-label="What they can do"
                            value={capability}
                            onValueChange={setCapability}
                            options={capabilities.map((one) => ({
                                value: one,
                                label: CAPABILITY_WORDS[one]?.label ?? one
                            }))}
                        />
                        <p className="text-[12px] text-foreground-subtle">
                            {CAPABILITY_WORDS[capability]?.hint ?? ""}
                        </p>
                    </div>

                    {bounded ? (
                        <div className="flex flex-col gap-3">
                            <label className="flex items-center justify-between gap-2 text-[13px] text-foreground">
                                <span className="flex items-center gap-2">
                                    <CalendarClock
                                        className="size-4 shrink-0 text-foreground-subtle"
                                        aria-hidden
                                    />
                                    Only sometimes
                                </span>
                                <Switch
                                    checked={limited}
                                    onChange={setLimited}
                                    aria-label="Limit when this works"
                                />
                            </label>

                            {limited ? (
                                <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <Field label="From this day" htmlFor="share-from-day">
                                            <Input
                                                id="share-from-day"
                                                type="date"
                                                value={startsAt}
                                                onChange={(event) =>
                                                    setStartsAt(event.target.value)
                                                }
                                            />
                                        </Field>
                                        <Field label="Until this day" htmlFor="share-to-day">
                                            <Input
                                                id="share-to-day"
                                                type="date"
                                                value={endsAt}
                                                onChange={(event) => setEndsAt(event.target.value)}
                                            />
                                        </Field>
                                    </div>

                                    <fieldset className="flex flex-col gap-1">
                                        <legend className="text-[12px] text-muted-foreground">
                                            On these days
                                        </legend>
                                        <div className="flex flex-wrap gap-1">
                                            {weekOrder.map((day: number) => {
                                                const on = core.runsOnDay(days, day);
                                                return (
                                                    <button
                                                        key={day}
                                                        type="button"
                                                        aria-pressed={on}
                                                        onClick={() =>
                                                            setDays(core.toggleDay(days, day))
                                                        }
                                                        className={cn(
                                                            "rounded-md border px-2 py-1 text-[12px]",
                                                            on
                                                                ? "border-primary bg-primary/10 text-foreground"
                                                                : "border-border text-muted-foreground"
                                                        )}
                                                    >
                                                        {core.DAY_SHORT_NAMES[day]}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </fieldset>

                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <Field label="From this hour" htmlFor="share-from-hour">
                                            <Input
                                                id="share-from-hour"
                                                type="time"
                                                value={hours.from}
                                                onChange={(event) =>
                                                    setHours({ ...hours, from: event.target.value })
                                                }
                                            />
                                        </Field>
                                        <Field label="Until this hour" htmlFor="share-to-hour">
                                            <Input
                                                id="share-to-hour"
                                                type="time"
                                                value={hours.to}
                                                onChange={(event) =>
                                                    setHours({ ...hours, to: event.target.value })
                                                }
                                            />
                                        </Field>
                                    </div>

                                    <Field label="How many times" htmlFor="share-uses">
                                        <Input
                                            id="share-uses"
                                            type="number"
                                            min={1}
                                            inputMode="numeric"
                                            placeholder="As often as they like"
                                            value={maxUses}
                                            onChange={(event) => setMaxUses(event.target.value)}
                                        />
                                    </Field>
                                    <p className="text-[12px] text-foreground-subtle">
                                        Only actually operating it counts. Looking at it does not.
                                    </p>
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    <Field label="What this is for" htmlFor="share-note">
                        <Input
                            id="share-note"
                            value={note}
                            placeholder="Cleaner, Tuesdays"
                            onChange={(event) => setNote(event.target.value)}
                        />
                    </Field>

                    <div className="flex justify-end">
                        <Button
                            disabled={busy || !principalId}
                            aria-disabled={busy || !principalId}
                            onClick={() => void add()}
                        >
                            {busy ? (
                                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                            ) : null}
                            Share
                        </Button>
                    </div>
                </section>
                {extra}
                {confirmDialog}
            </DialogContent>
        </Dialog>
    );
}

function Field({
    label,
    htmlFor,
    children
}: {
    label: string;
    htmlFor: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1">
            <label className="text-[12px] text-muted-foreground" htmlFor={htmlFor}>
                {label}
            </label>
            {children}
        </div>
    );
}

/** The bounds of one grant in a line, or "" when it has none. Dates are drawn
 *  through the reader's own format, like every other date here. */
function describe(grant: GrantView, weekOrder: readonly number[]): string {
    return core.describeGrant(
        {
            ...grant.schedule,
            startsAt: grant.schedule.startsAt ? new Date(grant.schedule.startsAt) : null,
            endsAt: grant.schedule.endsAt ? new Date(grant.schedule.endsAt) : null
        },
        weekOrder,
        (date) => date.toISOString().slice(0, 10)
    );
}
