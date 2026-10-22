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
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import { useDisplayFormat } from "@/components/display-format";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { GrantCandidate } from "@/lib/access/sharing-service";
import {
    CalendarClock,
    Copy,
    Link2,
    Loader2,
    MapPin,
    Search,
    Trash2,
    UserRound,
    Users
} from "lucide-react";
import {
    findSharePeopleAction,
    listGrantsAction,
    revokeShareAction,
    shareAction,
    shareLinkAction
} from "@/app/(app)/access-actions";
import {
    Badge,
    Button,
    Checkbox,
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

/** The capabilities this dialog has words for, as `share.capabilities.<id>`. */
const CAPABILITIES = new Set(["guest", "member", "admin", "view", "control"]);

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
    const t = useTranslations("components");
    const locale = useLocale();
    const capabilityLabel = (one: string) =>
        CAPABILITIES.has(one)
            ? t(`share.capabilities.${one}.label` as NamespaceKey<"components">)
            : one;
    const capabilityHint = (one: string) =>
        CAPABILITIES.has(one)
            ? t(`share.capabilities.${one}.hint` as NamespaceKey<"components">)
            : "";
    const dayNames = useMemo(() => core.weekdayNames(locale, "short"), [locale]);
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
    // Which of the subject's actions the grant allows (open, close, operate;
    // watch, control). All of what the capability reaches until narrowed.
    const reachable = core.grantActions(subject, capability, []);
    const [actions, setActions] = useState<string[]>(reachable);
    const pickCapability = (next: string): void => {
        setCapability(next);
        setActions(core.grantActions(subject, next, []));
    };
    // A grant that allows nothing is a "no" that looks like a "yes".
    const noAction = reachable.length > 0 && !reachable.some((one) => actions.includes(one));
    const actionLabel = (one: string) => t(`share.actions.${one}` as NamespaceKey<"components">);
    // Who it goes to: a person, a team, a role - or, for what may be handed out
    // that way, a link anybody can open with no account.
    const [kind, setKind] = useState<core.GrantPrincipal | "link">("user");
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
    // Only near the place, and how near. Offered where an act happens at a
    // place - a door, a UPS - and nowhere else.
    const fenceable = subject === "place.device" || subject === "place.ups";
    const linkable = core.isGrantLinkSubject(subject);
    // What a link may carry here: a NAS, a server or a domain is only ever seen
    // through one, whatever a person could be given.
    const linkCapabilities: readonly string[] = linkable ? core.linkCapabilities(subject) : [];
    const linkNarrower = linkable && linkCapabilities.length < capabilities.length;
    const [nearby, setNearby] = useState(false);
    const [nearbyMeters, setNearbyMeters] = useState("100");
    const [located, setLocated] = useState<boolean | null>(null);
    /** A link just made: shown once, since only its hash is kept. */
    const [madeLink, setMadeLink] = useState<string | null>(null);

    const load = useCallback(async () => {
        const answer = await listGrantsAction(subject, subjectId);
        if (answer.error) {
            toast.show({ title: answer.error });
            setGrants([]);
            return;
        }
        setGrants(answer.grants ?? []);
        setCandidates(answer.candidates ?? []);
        setLocated(answer.located ?? null);
    }, [subject, subjectId, toast]);

    useEffect(() => {
        if (!open) return;
        setGrants(null);
        setMadeLink(null);
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
    const asLink = kind === "link";
    /** Ready to send: somebody picked, or a link, which names nobody. */
    const ready = asLink || Boolean(principalId);

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
        setNearby(false);
        setNearbyMeters("100");
    };

    /** What bounds the grant, the same for a person and for a link. */
    const bounds = () => ({
        capability,
        actions: reachable.filter((one) => actions.includes(one)),
        note,
        nearbyMeters: fenceable && nearby ? Number(nearbyMeters) : null,
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
    const metres = Number(nearbyMeters);
    const badFence =
        fenceable &&
        nearby &&
        (!Number.isInteger(metres) || metres < core.NEARBY_MIN_M || metres > core.NEARBY_MAX_M);

    const makeLink = async (): Promise<void> => {
        if (noAction || badFence) return;
        setBusy(true);
        const answer = await shareLinkAction(subject, subjectId, bounds());
        setBusy(false);
        if (answer.error || !answer.link) {
            toast.show({ title: answer.error ?? t("share.needAction") });
            return;
        }
        setGrants(answer.grants ?? []);
        setMadeLink(answer.link);
        reset();
    };

    const copyLink = async (): Promise<void> => {
        if (!madeLink) return;
        try {
            await navigator.clipboard.writeText(madeLink);
            toast.show({ title: t("share.copied") });
        } catch {
            // A browser that refuses the clipboard still shows the link,
            // selected, for copying by hand.
        }
    };

    /** Who a grant is to, in words: a link has nobody, so it is called one. */
    const who = (grant: GrantView): string =>
        grant.principalType === "link" ? t("share.linkName") : grant.principalName;

    const add = async (): Promise<void> => {
        if (kind === "link") return makeLink();
        if (!principalId || noAction || badFence) return;
        setBusy(true);
        const answer = await shareAction(subject, subjectId, {
            principalType: kind,
            principalId,
            ...bounds()
        });
        setBusy(false);
        if (answer.error) {
            toast.show({ title: answer.error });
            return;
        }
        setGrants(answer.grants ?? []);
        reset();
        toast.show({ title: t("share.shared") });
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
            title: t("share.stopTitle", { name: who(grant) }),
            description: t("share.stopBody", { who: who(grant), what: name }),
            confirmLabel: t("share.stop"),
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
        toast.show({ title: t("share.takenBack") });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {/* Wider than the default, and deliberately: the form is two columns
                of times on a laptop and one on a phone, and at the default width
                it is one column of fourteen rows. */}
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>{t("share.title", { name })}</DialogTitle>
                    <DialogDescription>
                        {bounded ? t("share.introBounded") : t("share.intro")}
                    </DialogDescription>
                </DialogHeader>

                <section className="flex flex-col gap-2" aria-label={t("share.already")}>
                    {grants === null ? (
                        <>
                            <Skeleton className="h-12 w-full" />
                            <Skeleton className="h-12 w-full" />
                        </>
                    ) : grants.length === 0 ? (
                        <p className="text-[13px] text-muted-foreground">{t("share.none")}</p>
                    ) : (
                        <ul className="flex flex-col gap-1">
                            {grants.map((grant) => (
                                <li
                                    key={grant.id}
                                    className="flex items-start gap-2 rounded-lg border border-border px-3 py-2"
                                >
                                    <span className="mt-0.5 text-foreground-subtle">
                                        {grant.principalType === "link" ? (
                                            <Link2 className="size-4 shrink-0" aria-hidden />
                                        ) : grant.principalType === "user" ? (
                                            <UserRound className="size-4 shrink-0" aria-hidden />
                                        ) : (
                                            <Users className="size-4 shrink-0" aria-hidden />
                                        )}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <p className="flex flex-wrap items-center gap-2 text-[13px] text-foreground">
                                            <span className="truncate font-medium">
                                                {who(grant)}
                                            </span>
                                            {grant.orgName ? (
                                                <span className="text-foreground-subtle">
                                                    {grant.orgName}
                                                </span>
                                            ) : null}
                                            <Badge variant={STANDING_TONE[grant.standing]}>
                                                {t(`share.standings.${grant.standing}`)}
                                            </Badge>
                                        </p>
                                        <p className="text-[12px] text-muted-foreground">
                                            {capabilityLabel(grant.capability)}
                                            {grant.actions.length > 0 &&
                                            grant.actions.length <
                                                core.grantActions(subject, grant.capability, [])
                                                    .length
                                                ? ` (${grant.actions.map(actionLabel).join(", ")})`
                                                : null}
                                            {describe(grant, weekOrder, t, dayNames) ? (
                                                <> - {describe(grant, weekOrder, t, dayNames)}</>
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
                                        aria-label={t("share.stopNamed", { name: who(grant) })}
                                        title={t("share.stopNamed", { name: who(grant) })}
                                        onClick={() => void revoke(grant)}
                                    >
                                        <Trash2 className="size-4 shrink-0" aria-hidden />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                {madeLink ? (
                    <div
                        role="status"
                        className="flex min-w-0 flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3"
                    >
                        <p className="text-[12px] text-muted-foreground">{t("share.linkMade")}</p>
                        <div className="flex min-w-0 items-center gap-2">
                            <Input
                                readOnly
                                value={madeLink}
                                aria-label={t("share.linkName")}
                                onFocus={(event) => event.target.select()}
                                className="min-w-0 flex-1"
                            />
                            <Button
                                size="icon"
                                variant="outline"
                                aria-label={t("share.copyLink")}
                                title={t("share.copyLink")}
                                onClick={() => void copyLink()}
                            >
                                <Copy className="size-4 shrink-0" aria-hidden />
                            </Button>
                        </div>
                    </div>
                ) : null}

                <section
                    className="flex flex-col gap-3 border-t border-border pt-4"
                    aria-label={t("share.more")}
                >
                    <SegmentedControl
                        aria-label={t("share.who")}
                        size="sm"
                        value={kind}
                        onValueChange={(next) => {
                            setKind(next);
                            setPrincipalId("");
                            if (next === "link" && !linkCapabilities.includes(capability)) {
                                pickCapability(linkCapabilities[0] ?? capability);
                            }
                        }}
                        options={[
                            { value: "user", label: t("share.person") },
                            {
                                value: "team",
                                label: t("share.team"),
                                disabled: !candidates.some((one) => one.type === "team"),
                                title: t("share.teamHint")
                            },
                            {
                                value: "role",
                                label: t("share.role"),
                                disabled: !candidates.some((one) => one.type === "role"),
                                title: t("share.roleHint")
                            },
                            ...(linkable
                                ? [
                                      {
                                          value: "link" as const,
                                          label: t("share.linkChoice"),
                                          title: t("share.linkHint")
                                      }
                                  ]
                                : [])
                        ]}
                    />

                    {asLink ? (
                        <p className="flex items-start gap-2 text-[12px] text-foreground-subtle">
                            <Link2 className="mt-0.5 size-4 shrink-0" aria-hidden />
                            {t("share.linkHint")}
                        </p>
                    ) : kind === "user" ? (
                        <div className="flex flex-col gap-1">
                            <label
                                className="text-[12px] text-muted-foreground"
                                htmlFor="share-who"
                            >
                                {t("share.search")}
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
                                    placeholder={t("share.searchPlaceholder")}
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
                            aria-label={
                                kind === "team" ? t("share.whichTeam") : t("share.whichRole")
                            }
                            value={principalId}
                            onValueChange={setPrincipalId}
                            placeholder={
                                kind === "team" ? t("share.pickTeam") : t("share.pickRole")
                            }
                            options={groups.map((one) => ({
                                value: one.id,
                                label: one.orgName ? `${one.orgName} - ${one.name}` : one.name
                            }))}
                        />
                    )}

                    <div className="flex flex-col gap-1">
                        <label className="text-[12px] text-muted-foreground" htmlFor="share-what">
                            {t("share.can")}
                        </label>
                        <Select
                            id="share-what"
                            aria-label={t("share.can")}
                            value={capability}
                            onValueChange={pickCapability}
                            options={capabilities.map((one) => ({
                                value: one,
                                label: capabilityLabel(one),
                                disabled: asLink && !linkCapabilities.includes(one)
                            }))}
                        />
                        <p className="text-[12px] text-foreground-subtle">
                            {capabilityHint(capability)}
                        </p>
                        {asLink && linkNarrower ? (
                            <p className="text-[12px] text-foreground-subtle">
                                {t("share.linkSeeOnly")}
                            </p>
                        ) : null}
                    </div>

                    {reachable.length > 1 ? (
                        <fieldset className="flex flex-col gap-1">
                            <legend className="text-[12px] text-muted-foreground">
                                {t("share.actionsLabel")}
                            </legend>
                            <div className="flex flex-wrap gap-x-4 gap-y-1">
                                {reachable.map((one) => (
                                    <label
                                        key={one}
                                        className="flex items-center gap-2 text-[13px] text-foreground"
                                    >
                                        <Checkbox
                                            checked={actions.includes(one)}
                                            onChange={(event) =>
                                                setActions((now) =>
                                                    event.target.checked
                                                        ? [...now, one]
                                                        : now.filter((held) => held !== one)
                                                )
                                            }
                                        />
                                        {actionLabel(one)}
                                    </label>
                                ))}
                            </div>
                        </fieldset>
                    ) : null}

                    {bounded ? (
                        <div className="flex flex-col gap-3">
                            <label className="flex items-center justify-between gap-2 text-[13px] text-foreground">
                                <span className="flex items-center gap-2">
                                    <CalendarClock
                                        className="size-4 shrink-0 text-foreground-subtle"
                                        aria-hidden
                                    />
                                    {t("share.sometimes")}
                                </span>
                                <Switch
                                    checked={limited}
                                    onChange={setLimited}
                                    aria-label={t("share.limit")}
                                />
                            </label>

                            {limited ? (
                                <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <Field label={t("share.fromDay")} htmlFor="share-from-day">
                                            <Input
                                                id="share-from-day"
                                                type="date"
                                                value={startsAt}
                                                onChange={(event) =>
                                                    setStartsAt(event.target.value)
                                                }
                                            />
                                        </Field>
                                        <Field label={t("share.toDay")} htmlFor="share-to-day">
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
                                            {t("share.days")}
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
                                                        {dayNames[day]}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </fieldset>

                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <Field
                                            label={t("share.fromHour")}
                                            htmlFor="share-from-hour"
                                        >
                                            <Input
                                                id="share-from-hour"
                                                type="time"
                                                value={hours.from}
                                                onChange={(event) =>
                                                    setHours({ ...hours, from: event.target.value })
                                                }
                                            />
                                        </Field>
                                        <Field label={t("share.toHour")} htmlFor="share-to-hour">
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

                                    <Field label={t("share.uses")} htmlFor="share-uses">
                                        <Input
                                            id="share-uses"
                                            type="number"
                                            min={1}
                                            inputMode="numeric"
                                            placeholder={t("share.usesPlaceholder")}
                                            value={maxUses}
                                            onChange={(event) => setMaxUses(event.target.value)}
                                        />
                                    </Field>
                                    <p className="text-[12px] text-foreground-subtle">
                                        {t("share.usesHint")}
                                    </p>
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    {fenceable ? (
                        <div className="flex flex-col gap-2">
                            <label className="flex items-center justify-between gap-2 text-[13px] text-foreground">
                                <span className="flex items-center gap-2">
                                    <MapPin
                                        className="size-4 shrink-0 text-foreground-subtle"
                                        aria-hidden
                                    />
                                    {t("share.nearbyLabel")}
                                </span>
                                <Switch
                                    checked={nearby}
                                    onChange={setNearby}
                                    aria-label={t("share.nearbyLabel")}
                                />
                            </label>
                            {nearby ? (
                                <>
                                    <Field label={t("share.nearbyMeters")} htmlFor="share-nearby">
                                        <Input
                                            id="share-nearby"
                                            type="number"
                                            min={core.NEARBY_MIN_M}
                                            max={core.NEARBY_MAX_M}
                                            step={25}
                                            inputMode="numeric"
                                            value={nearbyMeters}
                                            aria-invalid={badFence || undefined}
                                            onChange={(event) =>
                                                setNearbyMeters(event.target.value)
                                            }
                                        />
                                    </Field>
                                    <p className="text-[12px] text-foreground-subtle">
                                        {t("share.nearbyHint")}
                                    </p>
                                    {located === false ? (
                                        <p role="alert" className="text-[12px] text-danger-ink">
                                            {t("share.nearbyNoPlace")}
                                        </p>
                                    ) : null}
                                </>
                            ) : null}
                        </div>
                    ) : null}

                    <Field label={t("share.note")} htmlFor="share-note">
                        <Input
                            id="share-note"
                            value={note}
                            placeholder={t("share.notePlaceholder")}
                            onChange={(event) => setNote(event.target.value)}
                        />
                    </Field>

                    <div className="flex justify-end">
                        <Button
                            disabled={busy || !ready || noAction || badFence}
                            aria-disabled={busy || !ready || noAction || badFence}
                            onClick={() => void add()}
                        >
                            {busy ? (
                                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                            ) : asLink ? (
                                <Link2 className="size-4 shrink-0" aria-hidden />
                            ) : null}
                            {asLink ? t("share.makeLink") : t("share.share")}
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
function describe(
    grant: GrantView,
    weekOrder: readonly number[],
    t: NamespaceTranslator<"components">,
    dayNames: readonly string[]
): string {
    // `core.describeGrant`'s sentence, in the reader's words.
    const schedule = grant.schedule;
    const day = (iso: string) => iso.slice(0, 10);
    const parts: string[] = [];
    if (schedule.startsAt && schedule.endsAt) {
        parts.push(t("share.range", { from: day(schedule.startsAt), to: day(schedule.endsAt) }));
    } else if (schedule.startsAt) {
        parts.push(t("share.fromOnly", { from: day(schedule.startsAt) }));
    } else if (schedule.endsAt) {
        parts.push(t("share.untilOnly", { to: day(schedule.endsAt) }));
    }
    const mask = schedule.days & core.EVERY_DAY;
    if (mask !== core.EVERY_DAY) {
        parts.push(
            mask === core.WEEKDAYS
                ? t("share.weekdays")
                : mask === core.WEEKEND
                  ? t("share.weekends")
                  : mask === 0
                    ? t("share.noDays")
                    : weekOrder
                          .filter((one) => core.runsOnDay(mask, one))
                          .map((one) => dayNames[one])
                          .join(", ")
        );
    }
    if (schedule.startMinute !== null && schedule.endMinute !== null) {
        parts.push(
            t("share.range", {
                from: core.clockTime(schedule.startMinute),
                to: core.clockTime(schedule.endMinute)
            })
        );
    }
    if (schedule.maxUses !== null) {
        parts.push(t("share.usesOf", { uses: schedule.uses, max: schedule.maxUses }));
    }
    return parts.join(" - ");
}
