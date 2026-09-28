"use client";

/**
 * The Events tab: what is on now, the events this server has, when they come
 * round on their own, and how the last ones went.
 *
 * Everything that does not depend on the server's answer is drawn at once;
 * only the values wait. What is on is asked for again every few seconds while
 * something is on, and every half minute otherwise, so a scheduled or drawn
 * event appears here without a reload.
 */

import * as actions from "./events-actions";
import { EventEditor } from "./event-editor";
import { hostUi } from "@polaris/app-host/client";
import * as catalog from "../../lib/minecraft/events/catalog";
import type { EventHistoryEntry } from "../../lib/minecraft/events/state";
import type { EventsView } from "../../lib/minecraft/events/events-service";
import { Copy, FastForward, Info, Loader2, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import * as ui from "@polaris/ui";

const { useConfirm } = hostUi.confirmDialog;
const { useDisplayFormat } = hostUi.displayFormat;
const { readSnapshot, writeSnapshot } = hostUi.snapshotCache;

const SNAPSHOT_MS = 30_000;
const snapshotKey = (installedAppId: string) => `minecraft-events:${installedAppId}`;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const TRIGGER_LABEL: Readonly<Record<EventHistoryEntry["trigger"], string>> = {
    manual: "Run by hand",
    scheduled: "Scheduled",
    random: "Drawn at random"
};

const OUTCOME: Readonly<
    Record<
        EventHistoryEntry["outcome"],
        { label: string; tone: "success" | "neutral" | "warning" | "danger" }
    >
> = {
    finished: { label: "Finished", tone: "success" },
    cancelled: { label: "Called off", tone: "neutral" },
    skipped: { label: "Skipped", tone: "warning" },
    failed: { label: "Failed", tone: "danger" }
};

/** m:ss, or h:mm:ss past an hour. */
function clock(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, "0");
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
        : `${minutes}:${seconds}`;
}

function rewardText(reward: catalog.Reward): string {
    const parts = reward.items.map(
        (item) => `${item.count} ${item.id.replace(/^minecraft:/, "").replace(/_/g, " ")}`
    );
    if (reward.levels > 0) parts.push(`${reward.levels} levels`);
    return parts.join(", ") || "Nothing";
}

function newId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The days a rule applies on, as toggles. None picked means every day. */
function DayPicker({
    days,
    onChange
}: {
    days: readonly number[];
    onChange: (days: number[]) => void;
}) {
    return (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Days">
            {DAYS.map((label, day) => {
                const every = days.length === 0;
                const picked = every || days.includes(day);
                return (
                    <button
                        key={label}
                        type="button"
                        aria-pressed={picked}
                        onClick={() =>
                            onChange(
                                every
                                    ? DAYS.map((_, index) => index).filter((index) => index !== day)
                                    : picked
                                      ? days.filter((held) => held !== day)
                                      : [...days, day].sort()
                            )
                        }
                        className={ui.cn(
                            "rounded-md border px-2 py-1 text-xs transition-colors",
                            picked
                                ? "border-primary/50 bg-primary/10 text-foreground"
                                : "border-border text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {label}
                    </button>
                );
            })}
        </div>
    );
}

/**
 * What one event is, said in full: what it is, and what this one is set to -
 * how long, where it happens, what it takes to be ranked, when it will start on
 * its own and what it gives away.
 */
function EventExplained({
    preset,
    settings
}: {
    preset: catalog.EventPreset;
    settings: catalog.EventSettings | null;
}) {
    const info = catalog.KIND_INFO[preset.kind];
    const facts: string[] = [
        preset.kind === "trivia"
            ? `${(preset.options as catalog.EventOptions<"trivia">).rounds} rounds of ${(preset.options as catalog.EventOptions<"trivia">).seconds} seconds.`
            : `Lasts ${preset.minutes} minutes.`
    ];
    if (preset.kind === "happy-hour") {
        const options = preset.options as catalog.EventOptions<"happy-hour">;
        const effects = [
            options.haste && "Haste II (mining and digging faster)",
            options.luck && "Luck (better fishing and chest loot)",
            options.speed && "Speed (moving faster)",
            options.regeneration && "Regeneration (health comes back on its own)"
        ].filter(Boolean);
        facts.push(
            `Everybody on gets ${effects.join(", ")} until it ends, including whoever joins meanwhile.`
        );
    }
    if (catalog.needsOverworld(preset))
        facts.push("Happens in the Overworld; only players there take part.");
    if (catalog.hasMinScore(preset)) {
        facts.push(
            `Ranked from ${catalog.minScoreOf(preset)} ${info.unit}; below that, no podium and no prize.`
        );
    }
    if (settings) {
        const needed = catalog.activeNeeded(preset, settings);
        facts.push(
            `Starts on its own only with ${needed} ${needed === 1 ? "player" : "players"} actually playing, and not while somebody is in a fight.`
        );
    }
    if (catalog.needsHostileMobs(preset)) {
        facts.push("Needs the server above Peaceful, where hostile mobs exist.");
    }
    if (info.competitive) {
        facts.push(
            catalog.afkCounts(preset)
                ? "Nobody playing in creative or spectator, caught by the anti-cheat, or AFK the whole time is ranked."
                : "Nobody playing in creative or spectator, or caught by the anti-cheat, is ranked."
        );
    }
    if (info.competitive) {
        const prizes = [
            ["1st", preset.rewards.first],
            ["2nd", preset.rewards.second],
            ["3rd", preset.rewards.third],
            ["taking part", preset.rewards.everyone]
        ] as const;
        const given = prizes.filter(([, reward]) => reward.items.length > 0 || reward.levels > 0);
        facts.push(
            given.length > 0
                ? `Prizes - ${given.map(([place, reward]) => `${place}: ${rewardText(reward)}`).join("; ")}.`
                : "No prizes set."
        );
    }
    return (
        <div className="mt-2 flex flex-col gap-1 rounded-md bg-muted/40 px-3 py-2 text-xs">
            <p className="text-foreground">{info.summary}</p>
            {facts.map((fact) => (
                <p key={fact} className="text-muted-foreground">
                    {fact}
                </p>
            ))}
        </div>
    );
}

export function MinecraftEvents({
    installedAppId,
    canManage
}: {
    installedAppId: string;
    canManage: boolean;
}) {
    const display = useDisplayFormat();
    const [view, setView] = useState<EventsView | null>(
        () => readSnapshot<EventsView>(snapshotKey(installedAppId), SNAPSHOT_MS)?.value ?? null
    );
    const [draft, setDraft] = useState<catalog.EventsConfig | null>(() => view?.config ?? null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    /** The events whose explanation is open under their row. */
    const [explained, setExplained] = useState<ReadonlySet<string>>(() => new Set());
    const explain = (id: string) =>
        setExplained((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    const [editing, setEditing] = useState<{ preset: catalog.EventPreset; isNew: boolean } | null>(
        null
    );
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();
    const [now, setNow] = useState(() => Date.now());

    const accept = useCallback(
        (next: EventsView, replaceDraft: boolean) => {
            setView(next);
            writeSnapshot(snapshotKey(installedAppId), next);
            if (replaceDraft) setDraft(next.config);
        },
        [installedAppId]
    );

    const dirty =
        view !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(view.config);

    // Read on open and again on a beat: quickly while something is on, so the
    // clock and the standings move; slowly otherwise, so an event that starts
    // on its own shows up. An edit in progress is never overwritten by a read.
    const running = view?.run !== null && view?.run !== undefined;
    useEffect(() => {
        let alive = true;
        const read = () =>
            void actions
                .readEventsAction(installedAppId)
                .then((answer) => {
                    if (!alive) return;
                    if (answer.view) {
                        setView(answer.view);
                        writeSnapshot(snapshotKey(installedAppId), answer.view);
                        setDraft((current) => current ?? answer.view!.config);
                    } else setError(answer.error ?? "The events could not be read");
                })
                .catch(() => {
                    // A read that did not come back - a restart, a dropped
                    // connection - is tried again on the next beat.
                });
        read();
        const timer = setInterval(read, running ? 5_000 : 30_000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [installedAppId, running]);

    // A line about what was just done is said once and goes: "Blood moon is
    // starting" left on screen until a reload read as the event never moving on.
    useEffect(() => {
        if (!note) return;
        const timer = setTimeout(() => setNote(null), 5_000);
        return () => clearTimeout(timer);
    }, [note]);

    useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, [running]);

    const checked = useMemo(
        () => (draft ? catalog.eventsConfigSchema.safeParse(draft) : null),
        [draft]
    );
    const problem =
        checked && !checked.success
            ? (checked.error.issues[0]?.message ?? "Check the events")
            : null;

    function save(): void {
        if (!draft || problem) return;
        setError(null);
        startTransition(async () => {
            const answer = await actions.saveEventsAction({ installedAppId, config: draft });
            if (!answer.view) {
                setError(answer.error ?? "The events could not be saved");
                return;
            }
            accept(answer.view, true);
            setNote("Saved.");
        });
    }

    function run(preset: catalog.EventPreset): void {
        setError(null);
        setNote(null);
        startTransition(async () => {
            const answer = await actions.startEventAction({ installedAppId, presetId: preset.id });
            if (!answer.view) {
                setError(answer.error ?? "The event could not start");
                return;
            }
            accept(answer.view, false);
            setNote(`${preset.name} is starting.`);
        });
    }

    async function cancel(): Promise<void> {
        const sure = await confirm({
            title: "Call off the event?",
            description:
                "It stops now, nobody wins, and everything it put in the world is taken out again.",
            confirmLabel: "Call it off"
        });
        if (!sure) return;
        startTransition(async () => {
            const answer = await actions.cancelEventAction(installedAppId);
            if (answer.view) accept(answer.view, false);
            else setError(answer.error ?? "The event could not be called off");
        });
    }

    function startNow(): void {
        startTransition(async () => {
            const answer = await actions.startNowAction(installedAppId);
            if (answer.view) accept(answer.view, false);
            else setError(answer.error ?? "The event could not start now");
        });
    }

    async function remove(preset: catalog.EventPreset): Promise<void> {
        const sure = await confirm({
            title: `Delete ${preset.name}?`,
            description:
                "It also comes off the schedule and out of the random draw. Save to keep the change.",
            confirmLabel: "Delete"
        });
        if (!sure || !draft) return;
        setDraft({
            ...draft,
            presets: draft.presets.filter((one) => one.id !== preset.id),
            schedules: draft.schedules.filter((one) => one.presetId !== preset.id),
            settings: {
                ...draft.settings,
                random: {
                    ...draft.settings.random,
                    pool: draft.settings.random.pool.filter((one) => one.presetId !== preset.id)
                }
            }
        });
    }

    async function forget(id: string, player: string): Promise<void> {
        const sure = await confirm({
            title: `Stop waiting to give ${player} their prize?`,
            description: "It is not given when they come back.",
            confirmLabel: "Forget it"
        });
        if (!sure) return;
        startTransition(async () => {
            const answer = await actions.forgetPrizeAction({ installedAppId, pendingId: id });
            if (answer.view) accept(answer.view, false);
            else setError(answer.error ?? "That prize could not be forgotten");
        });
    }

    const settings = draft?.settings;
    const change = (patch: Partial<catalog.EventsConfig>) => {
        setDraft((current) => (current ? { ...current, ...patch } : current));
        setNote(null);
    };
    const changeSettings = (patch: Partial<catalog.EventSettings>) =>
        setDraft((current) =>
            current ? { ...current, settings: { ...current.settings, ...patch } } : current
        );
    const changeRandom = (patch: Partial<catalog.RandomEvents>) =>
        setDraft((current) =>
            current
                ? {
                      ...current,
                      settings: {
                          ...current.settings,
                          random: { ...current.settings.random, ...patch }
                      }
                  }
                : current
        );
    const presets = draft?.presets ?? [];
    const presetOptions = presets.map((one) => ({ value: one.id, label: one.name }));
    const refusal = view?.refusal ?? null;
    const locked = !canManage || refusal !== null;

    return (
        <div className="flex flex-col gap-4">
            {refusal && (
                <ui.Card>
                    <ui.CardBody className="text-sm text-muted-foreground">{refusal}.</ui.CardBody>
                </ui.Card>
            )}

            {/* What is on now. */}
            <ui.Card>
                <ui.CardBody className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-sm font-medium">Now</p>
                            {!view ? (
                                <ui.Skeleton className="mt-1 h-4 w-56" />
                            ) : view.run ? (
                                <p className="text-sm">
                                    <span className="font-medium">{view.run.name}</span>
                                    <span className="text-muted-foreground">
                                        {" - "}
                                        {view.run.cancelling
                                            ? "being called off"
                                            : view.run.phase === "countdown"
                                              ? `starts in ${clock(view.run.startsAt - now)}`
                                              : `${clock(view.run.endsAt - now)} left`}
                                        {" - "}
                                        {TRIGGER_LABEL[view.run.trigger].toLowerCase()}
                                    </span>
                                </p>
                            ) : (
                                <p className="text-sm text-muted-foreground">
                                    No event is on.
                                    {view.players
                                        ? ` ${view.players.online} on the server, ${view.players.active} of them playing.`
                                        : ""}
                                </p>
                            )}
                        </div>
                        {view?.run && canManage && !view.run.cancelling && (
                            <div className="flex flex-wrap gap-2">
                                {view.run.phase === "countdown" && (
                                    <ui.Button
                                        size="sm"
                                        disabled={pending}
                                        onClick={startNow}
                                    >
                                        <FastForward className="size-4" />
                                        Start now
                                    </ui.Button>
                                )}
                                <ui.Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={pending}
                                    onClick={() => void cancel()}
                                >
                                    <Square className="size-4" />
                                    Call off
                                </ui.Button>
                            </div>
                        )}
                    </div>
                    {view?.run && view.run.standings.length > 0 && (
                        <ol className="flex flex-col gap-1 text-sm">
                            {view.run.standings.slice(0, 5).map((one, index) => (
                                <li
                                    key={one.name}
                                    className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-1.5"
                                >
                                    <span className="min-w-0 truncate">
                                        <span className="mr-2 tabular-nums text-muted-foreground">
                                            {index + 1}
                                        </span>
                                        {one.name}
                                    </span>
                                    <span className="tabular-nums text-muted-foreground">
                                        {one.score} {catalog.KIND_INFO[view.run!.kind].unit}
                                    </span>
                                </li>
                            ))}
                        </ol>
                    )}
                    {!view?.run &&
                        view &&
                        (view.nextRandomAt || view.waiting) &&
                        settings?.random.enabled && (
                            <p className="text-xs text-muted-foreground">
                                {view.waiting
                                    ? `The next drawn event is due - ${view.waiting.charAt(0).toLowerCase()}${view.waiting.slice(1)}.`
                                    : view.nextRandomAt
                                      ? `The next drawn event comes from ${display.dateTime(view.nextRandomAt)}.`
                                      : null}
                            </p>
                        )}
                </ui.CardBody>
            </ui.Card>

            {/* The events this server has. */}
            <ui.Card>
                <ui.CardBody className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-sm font-medium">Events</p>
                        {!locked && draft && (
                            // A button that says what it does, opening the kinds
                            // with a line about each - rather than a select with
                            // nothing chosen, which read as a setting.
                            <ui.DropdownMenu>
                                <ui.DropdownMenuTrigger asChild>
                                    <ui.Button variant="secondary" size="sm">
                                        <Plus className="size-4" />
                                        Add an event
                                    </ui.Button>
                                </ui.DropdownMenuTrigger>
                                <ui.DropdownMenuContent align="end" className="w-80">
                                    {catalog.EVENT_KINDS.map((kind) => (
                                        <ui.DropdownMenuItem
                                            key={kind}
                                            className="flex flex-col items-start gap-0.5"
                                            onSelect={() =>
                                                setEditing({
                                                    preset: catalog.newPreset(kind, newId()),
                                                    isNew: true
                                                })
                                            }
                                        >
                                            <span className="text-sm">
                                                {catalog.KIND_INFO[kind].label}
                                            </span>
                                            <span className="line-clamp-2 text-xs text-muted-foreground">
                                                {catalog.KIND_INFO[kind].summary}
                                            </span>
                                        </ui.DropdownMenuItem>
                                    ))}
                                </ui.DropdownMenuContent>
                            </ui.DropdownMenu>
                        )}
                    </div>
                    {!draft ? (
                        <div className="flex flex-col gap-2" aria-busy="true">
                            <ui.Skeleton className="h-10 w-full" />
                            <ui.Skeleton className="h-10 w-full" />
                            <ui.Skeleton className="h-10 w-2/3" />
                        </div>
                    ) : presets.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No events yet. Add one above.
                        </p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                            {presets.map((preset) => (
                                <li key={preset.id} className="flex flex-col px-3 py-2">
                                    <div className="flex flex-wrap items-center gap-3">
                                        <div className="min-w-0 flex-1">
                                            <p
                                                className="truncate text-sm font-medium"
                                                title={preset.name}
                                            >
                                                {preset.name}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {catalog.KIND_INFO[preset.kind].label}
                                                {" - "}
                                                {preset.kind === "trivia"
                                                    ? `${(preset.options as catalog.EventOptions<"trivia">).rounds} rounds`
                                                    : `${preset.minutes} min`}
                                                {catalog.KIND_INFO[preset.kind].competitive
                                                    ? ` - first place: ${rewardText(preset.rewards.first)}`
                                                    : ""}
                                            </p>
                                        </div>
                                        <ui.Switch
                                            checked={preset.enabled}
                                            disabled={locked}
                                            aria-label={`${preset.name} can come round on its own`}
                                            onChange={(enabled) =>
                                                change({
                                                    presets: presets.map((one) =>
                                                        one.id === preset.id
                                                            ? { ...one, enabled }
                                                            : one
                                                    )
                                                })
                                            }
                                        />
                                        <div className="flex items-center gap-1">
                                            <ui.Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={`What ${preset.name} is`}
                                                title={`What ${preset.name} is`}
                                                aria-expanded={explained.has(preset.id)}
                                                onClick={() => explain(preset.id)}
                                            >
                                                <Info className="size-4" />
                                            </ui.Button>
                                            <ui.Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={`Run ${preset.name} now`}
                                                title={
                                                    dirty ? "Save first" : `Run ${preset.name} now`
                                                }
                                                disabled={
                                                    locked ||
                                                    pending ||
                                                    running ||
                                                    dirty ||
                                                    !view?.config.presets.some(
                                                        (one) => one.id === preset.id
                                                    )
                                                }
                                                onClick={() => run(preset)}
                                            >
                                                <Play className="size-4" />
                                            </ui.Button>
                                            <ui.Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={`Edit ${preset.name}`}
                                                title={`Edit ${preset.name}`}
                                                disabled={locked}
                                                onClick={() => setEditing({ preset, isNew: false })}
                                            >
                                                <Pencil className="size-4" />
                                            </ui.Button>
                                            <ui.Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={`Duplicate ${preset.name}`}
                                                title={`Duplicate ${preset.name}`}
                                                disabled={locked}
                                                onClick={() =>
                                                    setEditing({
                                                        preset: {
                                                            ...preset,
                                                            id: newId(),
                                                            name: `${preset.name} 2`.slice(0, 40)
                                                        },
                                                        isNew: true
                                                    })
                                                }
                                            >
                                                <Copy className="size-4" />
                                            </ui.Button>
                                            <ui.Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={`Delete ${preset.name}`}
                                                title={`Delete ${preset.name}`}
                                                disabled={locked}
                                                onClick={() => void remove(preset)}
                                            >
                                                <Trash2 className="size-4" />
                                            </ui.Button>
                                        </div>
                                    </div>
                                    {explained.has(preset.id) && (
                                        <EventExplained
                                            preset={preset}
                                            settings={settings ?? null}
                                        />
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    <p className="text-xs text-muted-foreground">
                        The switch lets an event be scheduled or drawn at random. Run starts it now,
                        whoever is playing.
                    </p>
                </ui.CardBody>
            </ui.Card>

            {/* When they come round on their own. */}
            <ui.Card>
                <ui.CardBody className="flex flex-col gap-4">
                    <div>
                        <p className="text-sm font-medium">Automatic events</p>
                        <p className="text-xs text-muted-foreground">
                            An automatic event only starts while enough players are actually playing
                            - somebody who has not moved or turned for a while does not count.
                        </p>
                    </div>
                    {!settings ? (
                        <ui.Skeleton className="h-28 w-full" />
                    ) : (
                        <>
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">Players playing, at least</span>
                                    <ui.Input
                                        type="number"
                                        min={1}
                                        max={50}
                                        disabled={locked}
                                        value={
                                            Number.isFinite(settings.minActive)
                                                ? settings.minActive
                                                : ""
                                        }
                                        onChange={(event) =>
                                            changeSettings({
                                                minActive: Number(event.target.value || Number.NaN)
                                            })
                                        }
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">Idle after (minutes)</span>
                                    <ui.Input
                                        type="number"
                                        min={2}
                                        max={30}
                                        disabled={locked}
                                        value={
                                            Number.isFinite(settings.afkMinutes)
                                                ? settings.afkMinutes
                                                : ""
                                        }
                                        onChange={(event) =>
                                            changeSettings({
                                                afkMinutes: Number(event.target.value || Number.NaN)
                                            })
                                        }
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">Warning before it starts</span>
                                    <ui.Select
                                        value={String(settings.countdownSeconds)}
                                        disabled={locked}
                                        aria-label="Warning before it starts"
                                        options={[
                                            { value: "0", label: "None" },
                                            { value: "30", label: "30 seconds" },
                                            { value: "60", label: "1 minute" },
                                            { value: "120", label: "2 minutes" },
                                            { value: "300", label: "5 minutes" }
                                        ]}
                                        onValueChange={(value) =>
                                            changeSettings({ countdownSeconds: Number(value) })
                                        }
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">What players read</span>
                                    <ui.Select
                                        value={settings.language}
                                        disabled={locked}
                                        aria-label="What players read"
                                        options={[
                                            { value: "en", label: "English" },
                                            { value: "es", label: "Español" }
                                        ]}
                                        onValueChange={(value) =>
                                            changeSettings({ language: value as catalog.Language })
                                        }
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">Time zone</span>
                                    <ui.Input
                                        value={settings.timezone}
                                        disabled={locked}
                                        placeholder="Europe/Madrid"
                                        onChange={(event) =>
                                            changeSettings({ timezone: event.target.value })
                                        }
                                    />
                                </label>
                            </div>

                            <div className="flex flex-col gap-3 border-t border-border pt-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <p className="text-sm font-medium">Random events</p>
                                        <p className="text-xs text-muted-foreground">
                                            In the hours below, an event is drawn from the ones
                                            ticked every so often, weighted, and never the same kind
                                            twice in a row.
                                        </p>
                                    </div>
                                    <ui.Switch
                                        checked={settings.random.enabled}
                                        disabled={locked}
                                        aria-label="Draw events at random"
                                        onChange={(enabled) => changeRandom({ enabled })}
                                    />
                                </div>
                                {settings.random.enabled && (
                                    <>
                                        <DayPicker
                                            days={settings.random.days}
                                            onChange={(days) => changeRandom({ days })}
                                        />
                                        <div className="grid gap-3 sm:grid-cols-4">
                                            <label className="flex flex-col gap-1 text-sm">
                                                <span className="font-medium">From</span>
                                                <ui.Input
                                                    type="time"
                                                    value={settings.random.from}
                                                    disabled={locked}
                                                    onChange={(event) =>
                                                        changeRandom({ from: event.target.value })
                                                    }
                                                />
                                            </label>
                                            <label className="flex flex-col gap-1 text-sm">
                                                <span className="font-medium">Until</span>
                                                <ui.Input
                                                    type="time"
                                                    value={settings.random.to}
                                                    disabled={locked}
                                                    onChange={(event) =>
                                                        changeRandom({ to: event.target.value })
                                                    }
                                                />
                                            </label>
                                            <label className="flex flex-col gap-1 text-sm">
                                                <span className="font-medium">
                                                    Time between events: at least (min)
                                                </span>
                                                <ui.Input
                                                    type="number"
                                                    min={15}
                                                    disabled={locked}
                                                    value={
                                                        Number.isFinite(settings.random.minGap)
                                                            ? settings.random.minGap
                                                            : ""
                                                    }
                                                    onChange={(event) =>
                                                        changeRandom({
                                                            minGap: Number(
                                                                event.target.value || Number.NaN
                                                            )
                                                        })
                                                    }
                                                />
                                            </label>
                                            <label className="flex flex-col gap-1 text-sm">
                                                <span className="font-medium">
                                                    and at most (min)
                                                </span>
                                                <ui.Input
                                                    type="number"
                                                    min={15}
                                                    disabled={locked}
                                                    value={
                                                        Number.isFinite(settings.random.maxGap)
                                                            ? settings.random.maxGap
                                                            : ""
                                                    }
                                                    onChange={(event) =>
                                                        changeRandom({
                                                            maxGap: Number(
                                                                event.target.value || Number.NaN
                                                            )
                                                        })
                                                    }
                                                />
                                            </label>
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <p className="text-sm font-medium">Drawn from</p>
                                            {presets.map((preset) => {
                                                const entry = settings.random.pool.find(
                                                    (one) => one.presetId === preset.id
                                                );
                                                return (
                                                    <div
                                                        key={preset.id}
                                                        className="flex items-center gap-3 text-sm"
                                                    >
                                                        <ui.Switch
                                                            checked={entry !== undefined}
                                                            disabled={locked || !preset.enabled}
                                                            aria-label={`Draw ${preset.name}`}
                                                            onChange={(on) =>
                                                                changeRandom({
                                                                    pool: on
                                                                        ? [
                                                                              ...settings.random
                                                                                  .pool,
                                                                              {
                                                                                  presetId:
                                                                                      preset.id,
                                                                                  weight: 1
                                                                              }
                                                                          ]
                                                                        : settings.random.pool.filter(
                                                                              (one) =>
                                                                                  one.presetId !==
                                                                                  preset.id
                                                                          )
                                                                })
                                                            }
                                                        />
                                                        <span
                                                            className={ui.cn(
                                                                "min-w-0 flex-1 truncate",
                                                                !preset.enabled &&
                                                                    "text-muted-foreground"
                                                            )}
                                                        >
                                                            {preset.name}
                                                            {!preset.enabled && " (switched off)"}
                                                        </span>
                                                        {entry && (
                                                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                                                How often
                                                                <ui.Select
                                                                    value={String(entry.weight)}
                                                                    disabled={locked}
                                                                    aria-label={`How often ${preset.name} comes up`}
                                                                    options={[
                                                                        {
                                                                            value: "1",
                                                                            label: "Sometimes"
                                                                        },
                                                                        {
                                                                            value: "3",
                                                                            label: "Often"
                                                                        },
                                                                        {
                                                                            value: "6",
                                                                            label: "Very often"
                                                                        }
                                                                    ]}
                                                                    onValueChange={(value) =>
                                                                        changeRandom({
                                                                            pool: settings.random.pool.map(
                                                                                (one) =>
                                                                                    one.presetId ===
                                                                                    preset.id
                                                                                        ? {
                                                                                              ...one,
                                                                                              weight: Number(
                                                                                                  value
                                                                                              )
                                                                                          }
                                                                                        : one
                                                                            )
                                                                        })
                                                                    }
                                                                />
                                                            </label>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </>
                                )}
                            </div>

                            <div className="flex flex-col gap-3 border-t border-border pt-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <p className="text-sm font-medium">At set times</p>
                                        <p className="text-xs text-muted-foreground">
                                            Skipped, and written in the history, when too few are
                                            playing at that time.
                                        </p>
                                    </div>
                                    <ui.Button
                                        variant="secondary"
                                        size="sm"
                                        disabled={locked || presets.length === 0}
                                        onClick={() =>
                                            change({
                                                schedules: [
                                                    ...(draft?.schedules ?? []),
                                                    {
                                                        id: newId(),
                                                        presetId: presets[0]!.id,
                                                        enabled: true,
                                                        days: [],
                                                        at: "20:00"
                                                    }
                                                ]
                                            })
                                        }
                                    >
                                        <Plus className="size-4" />
                                        Add a time
                                    </ui.Button>
                                </div>
                                {(draft?.schedules ?? []).length === 0 ? (
                                    <p className="text-xs text-muted-foreground">No set times.</p>
                                ) : (
                                    <ul className="flex flex-col gap-2">
                                        {(draft?.schedules ?? []).map((entry) => {
                                            const update = (
                                                patch: Partial<catalog.EventScheduleEntry>
                                            ) =>
                                                change({
                                                    schedules: (draft?.schedules ?? []).map(
                                                        (one) =>
                                                            one.id === entry.id
                                                                ? { ...one, ...patch }
                                                                : one
                                                    )
                                                });
                                            return (
                                                <li
                                                    key={entry.id}
                                                    className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2"
                                                >
                                                    <div className="w-44">
                                                        <ui.Select
                                                            value={entry.presetId}
                                                            disabled={locked}
                                                            aria-label="Which event"
                                                            options={presetOptions}
                                                            onValueChange={(presetId) =>
                                                                update({ presetId })
                                                            }
                                                        />
                                                    </div>
                                                    <DayPicker
                                                        days={entry.days}
                                                        onChange={(days) => update({ days })}
                                                    />
                                                    <ui.Input
                                                        className="w-28"
                                                        type="time"
                                                        aria-label="At"
                                                        disabled={locked}
                                                        value={entry.at}
                                                        onChange={(event) =>
                                                            update({ at: event.target.value })
                                                        }
                                                    />
                                                    <ui.Switch
                                                        checked={entry.enabled}
                                                        disabled={locked}
                                                        aria-label="On"
                                                        onChange={(enabled) => update({ enabled })}
                                                    />
                                                    <ui.Button
                                                        variant="ghost"
                                                        size="icon-sm"
                                                        className="ml-auto"
                                                        aria-label="Remove this time"
                                                        title="Remove this time"
                                                        disabled={locked}
                                                        onClick={() =>
                                                            change({
                                                                schedules: (
                                                                    draft?.schedules ?? []
                                                                ).filter(
                                                                    (one) => one.id !== entry.id
                                                                )
                                                            })
                                                        }
                                                    >
                                                        <Trash2 className="size-4" />
                                                    </ui.Button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </div>
                        </>
                    )}
                </ui.CardBody>
            </ui.Card>

            {/* Saving what was changed above. */}
            {(dirty || error || note) && (
                <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-elevated px-4 py-3 shadow-modal">
                    <span
                        className={ui.cn(
                            "text-sm",
                            error || problem ? "text-danger" : "text-muted-foreground"
                        )}
                        role={error ? "alert" : undefined}
                    >
                        {error ?? (dirty ? (problem ?? "Unsaved changes.") : note)}
                    </span>
                    {dirty && (
                        <div className="flex items-center gap-2">
                            <ui.Button
                                variant="ghost"
                                disabled={pending}
                                onClick={() => view && setDraft(view.config)}
                            >
                                Discard
                            </ui.Button>
                            <ui.Button
                                disabled={pending || problem !== null || locked}
                                onClick={save}
                            >
                                {pending && <Loader2 className="size-4 animate-spin" />}
                                Save
                            </ui.Button>
                        </div>
                    )}
                </div>
            )}

            {/* Prizes still owed. */}
            {view && view.pending.length > 0 && (
                <ui.Card>
                    <ui.CardBody className="flex flex-col gap-2">
                        <div>
                            <p className="text-sm font-medium">Prizes waiting</p>
                            <p className="text-xs text-muted-foreground">
                                Given the next time each player is on. Kept for 14 days.
                            </p>
                        </div>
                        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                            {view.pending.map((one) => (
                                <li
                                    key={one.id}
                                    className="flex items-center gap-3 px-3 py-2 text-sm"
                                >
                                    <span className="font-medium">{one.player}</span>
                                    <span
                                        className="min-w-0 flex-1 truncate text-muted-foreground"
                                        title={rewardText(one.reward)}
                                    >
                                        {one.event} - {rewardText(one.reward)}
                                    </span>
                                    <ui.Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={`Forget ${one.player}'s prize`}
                                        title={`Forget ${one.player}'s prize`}
                                        disabled={!canManage || pending}
                                        onClick={() => void forget(one.id, one.player)}
                                    >
                                        <Trash2 className="size-4" />
                                    </ui.Button>
                                </li>
                            ))}
                        </ul>
                    </ui.CardBody>
                </ui.Card>
            )}

            {/* How the last ones went. */}
            <ui.Card>
                <ui.CardBody className="flex flex-col gap-2">
                    <p className="text-sm font-medium">History</p>
                    {!view ? (
                        <ui.Skeleton className="h-16 w-full" />
                    ) : view.history.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No events have run on this server yet.
                        </p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                            {view.history.map((entry) => (
                                <li
                                    key={entry.id}
                                    className="flex flex-col gap-1 px-3 py-2 text-sm"
                                >
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-medium">{entry.name}</span>
                                        <ui.Badge variant={OUTCOME[entry.outcome].tone}>
                                            {OUTCOME[entry.outcome].label}
                                        </ui.Badge>
                                        <span className="text-xs text-muted-foreground">
                                            {TRIGGER_LABEL[entry.trigger]} -{" "}
                                            {display.dateTime(entry.startedAt)} -{" "}
                                            {entry.participants} on
                                        </span>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        {entry.podium.length > 0
                                            ? entry.podium
                                                  .map(
                                                      (one) =>
                                                          `${one.place}. ${one.name} (${one.score})`
                                                  )
                                                  .join("  ")
                                            : entry.note}
                                        {entry.disqualified.length > 0 &&
                                            ` - left off by the anti-cheat: ${entry.disqualified.join(", ")}`}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    )}
                </ui.CardBody>
            </ui.Card>

            {editing && (
                <EventEditor
                    key={editing.preset.id}
                    preset={editing.preset}
                    open
                    onOpenChange={(open) => !open && setEditing(null)}
                    onSave={(preset) => {
                        change({
                            presets: editing.isNew
                                ? [...presets, preset]
                                : presets.map((one) => (one.id === preset.id ? preset : one))
                        });
                        setEditing(null);
                    }}
                />
            )}
            {confirmElement}
        </div>
    );
}
