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

import * as ui from "@polaris/ui";
import * as actions from "./events-actions";
import { EventEditor } from "./event-editor";
import type { GameKey } from "../../../messages";
import { hostUi } from "@polaris/app-host/client";
import { CATCH_LABELS } from "./event-options-rare-catch";
import { MATERIAL_LABELS } from "./event-options-gathering";
import { worldBossFacts } from "./event-options-world-boss";
import * as catalog from "../../lib/minecraft/events/catalog";
import { kindLabel, kindSummary, kindUnit } from "./event-kinds";
import { type GameText, useGameText, useSchemaText } from "../game-text";
import type { EventHistoryEntry } from "../../lib/minecraft/events/state";
import type { EventsView } from "../../lib/minecraft/events/events-service";
import type { SearchSummary } from "../../lib/minecraft/events/place-search";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
    Copy,
    Dices,
    FastForward,
    Info,
    Loader2,
    Pencil,
    Play,
    Plus,
    RotateCcw,
    Square,
    Trash2
} from "lucide-react";

const { useConfirm } = hostUi.confirmDialog;
const { useDisplayFormat } = hostUi.displayFormat;
const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;

const SNAPSHOT_MS = 30_000;
const snapshotKey = (installedAppId: string) => `minecraft-events:${installedAppId}`;
const DAYS: readonly GameKey<"minecraft">[] = [
    "schedule.days.sun",
    "schedule.days.mon",
    "schedule.days.tue",
    "schedule.days.wed",
    "schedule.days.thu",
    "schedule.days.fri",
    "schedule.days.sat"
];

const TRIGGER_LABEL: Readonly<Record<EventHistoryEntry["trigger"], GameKey<"minecraft">>> = {
    manual: "events.triggers.manual",
    scheduled: "events.triggers.scheduled",
    random: "events.triggers.random"
};

const OUTCOME: Readonly<
    Record<
        EventHistoryEntry["outcome"],
        { label: GameKey<"minecraft">; tone: "success" | "neutral" | "warning" | "danger" }
    >
> = {
    finished: { label: "events.outcomes.finished", tone: "success" },
    cancelled: { label: "events.outcomes.cancelled", tone: "neutral" },
    skipped: { label: "events.outcomes.skipped", tone: "warning" },
    failed: { label: "events.outcomes.failed", tone: "danger" }
};

/** m:ss, or h:mm:ss past an hour. */
/**
 * How the draw stands: when the next one comes (a countdown), why a due one
 * waits, the last one it started, and when the sweep last looked - the proof it
 * is alive.
 */
function DrawStatus({
    view,
    now,
    t,
    schemaText,
    dateTime
}: {
    view: EventsView;
    now: number;
    t: GameText<"minecraft">;
    schemaText: (text: string | null | undefined) => string | undefined;
    dateTime: (at: number) => string;
}): React.ReactElement {
    const lines: string[] = [];
    if (view.waiting && (!view.nextRandomAt || view.nextRandomAt <= now))
        lines.push(t("events.nextDue", { reason: lowerFirst(schemaText(view.waiting) ?? "") }));
    else if (view.nextRandomAt && view.nextRandomAt > now)
        lines.push(t("events.nextIn", { time: clock(view.nextRandomAt - now) }));
    else if (!view.nextRandomAt) lines.push(t("events.drawArming"));
    lines.push(
        view.lastRandom
            ? t("events.lastDrawn", {
                  name: view.lastRandom.name,
                  date: dateTime(view.lastRandom.startedAt)
              })
            : t("events.noneDrawnYet")
    );
    lines.push(
        view.drawCheckedAt
            ? t("events.drawChecked", { time: clock(now - view.drawCheckedAt) })
            : t("events.drawNotChecked")
    );
    return (
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {lines.map((line) => (
                <p key={line}>{line}</p>
            ))}
        </div>
    );
}

function clock(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, "0");
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
        : `${minutes}:${seconds}`;
}

function rewardText(t: GameText<"minecraft">, reward: catalog.Reward, joiner = ", "): string {
    const parts = reward.items.map(
        (item) => `${item.count} ${item.id.replace(/^minecraft:/, "").replace(/_/g, " ")}`
    );
    if (reward.levels > 0) parts.push(t("events.levels", { count: reward.levels }));
    return parts.join(joiner) || t("events.nothing");
}

const givesSomething = (reward: catalog.Reward) => reward.items.length > 0 || reward.levels > 0;

/** The podium places that pay a prize of their own. A place with none is paid the
 *  taking-part prize, so it is not listed apart: "everybody else" covers it. */
function podiumPrizes(t: GameText<"minecraft">, rewards: catalog.Rewards) {
    return (
        [
            [t("events.facts.first"), rewards.first],
            [t("events.facts.second"), rewards.second],
            [t("events.facts.third"), rewards.third]
        ] as const
    ).filter(([, reward]) => givesSomething(reward));
}

/** Every prize of an event on one line: "1st 5 diamond + 15 levels · 2nd ... ·
 *  Everybody else: 8 ...", or "Everybody: ..." when no place pays its own - and
 *  a world boss's trophy, when it gives one. */
function prizesLine(t: GameText<"minecraft">, preset: catalog.EventPreset): string {
    const { rewards } = preset;
    const places = podiumPrizes(t, rewards);
    const parts = places.map(([place, reward]) =>
        t("events.prizes.entry", { place, reward: rewardText(t, reward, " + ") })
    );
    if (givesSomething(rewards.everyone)) {
        const reward = rewardText(t, rewards.everyone, " + ");
        parts.push(
            places.length > 0
                ? t("events.prizes.everyone", { reward })
                : t("events.prizes.everybody", { reward })
        );
    }
    if (
        preset.kind === "world-boss" &&
        (preset.options as catalog.EventOptions<"world-boss">).trophy
    )
        parts.push(t("events.prizes.trophy"));
    return parts.join(" · ") || t("events.prizes.none");
}

/** Where an event looked for its place and what was in the way, when nowhere would do. */
function searchLine(t: GameText<"minecraft">, found: SearchSummary): string {
    const lead = found.from?.near
        ? t("events.placeSearch.fromNear", {
              tries: found.tries,
              near: found.from.near,
              x: found.from.x,
              z: found.from.z,
              reach: found.reach
          })
        : found.from
          ? t("events.placeSearch.fromAt", {
                tries: found.tries,
                x: found.from.x,
                z: found.from.z,
                reach: found.reach
            })
          : t("events.placeSearch.nobody");
    const sea = found.overSea ? ` ${t("events.placeSearch.overSea")}` : "";
    const why = found.why
        .map((one) => t(`events.placeSearch.why.${one.why}`, { count: one.count }))
        .join(", ");
    return why ? `${lead}${sea}: ${why}.` : `${lead}${sea}.`;
}

function lowerFirst(text: string): string {
    return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

function newId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** An event's row, under its name: the kind, how long, and every prize - cut to the
 *  row's width, the whole of it in the tooltip. */
function PresetDetail({ preset }: { preset: catalog.EventPreset }) {
    const t = useGameText("minecraft");
    const length =
        preset.kind === "trivia" || preset.kind === "gathering"
            ? t("events.rounds", {
                  count: (preset.options as catalog.EventOptions<"trivia" | "gathering">).rounds
              })
            : t("events.minutes", { count: preset.minutes });
    const detail = [
        kindLabel(t, preset.kind),
        length,
        catalog.KIND_INFO[preset.kind].competitive ? prizesLine(t, preset) : null
    ]
        .filter(Boolean)
        .join(" - ");
    return (
        <p className="truncate text-xs text-muted-foreground" title={detail}>
            {detail}
        </p>
    );
}

/** The days a rule applies on, as toggles. None picked means every day. */
function DayPicker({
    days,
    onChange
}: {
    days: readonly number[];
    onChange: (days: number[]) => void;
}) {
    const t = useGameText("minecraft");
    return (
        <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label={t("events.days")}
        >
            {DAYS.map((key, day) => {
                const label = t(key);
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
    const t = useGameText("minecraft");
    const info = catalog.KIND_INFO[preset.kind];
    const facts: string[] = [
        preset.kind === "trivia"
            ? t("events.facts.triviaRounds", {
                  rounds: (preset.options as catalog.EventOptions<"trivia">).rounds,
                  seconds: (preset.options as catalog.EventOptions<"trivia">).seconds
              })
            : t("events.facts.lasts", { minutes: catalog.runMinutes(preset) }),
        catalog.takesJoiners(preset)
            ? t("events.facts.needsJoiners", { count: catalog.joinersNeeded(preset) })
            : t("events.facts.needsPlayers", { count: catalog.minPlayersOf(preset) })
    ];
    if (preset.kind === "happy-hour") {
        const options = preset.options as catalog.EventOptions<"happy-hour">;
        const effects = [
            options.haste && t("events.facts.haste"),
            options.luck && t("events.facts.luck"),
            options.speed && t("events.facts.speed"),
            options.regeneration && t("events.facts.regeneration")
        ].filter(Boolean);
        facts.push(t("events.facts.happyHour", { effects: effects.join(", ") }));
    }
    if (preset.kind === "treasure-hunt") {
        const options = preset.options as catalog.EventOptions<"treasure-hunt">;
        facts.push(
            t("events.facts.chestsHidden", { count: options.chests, distance: options.distance }),
            t("events.facts.clues"),
            t("events.facts.chestsCleared")
        );
    }
    if (preset.kind === "gathering") {
        const options = preset.options as catalog.EventOptions<"gathering">;
        facts.push(
            t("events.facts.gatheringRounds", {
                rounds: options.rounds,
                minutes: options.roundMinutes
            }),
            options.material === "random"
                ? t("events.facts.materialRandom")
                : t("events.facts.material", {
                      material: t(MATERIAL_LABELS[options.material]).toLowerCase()
                  }),
            t("events.facts.gatheringScore")
        );
    }
    if (preset.kind === "rare-catch") {
        const options = preset.options as catalog.EventOptions<"rare-catch">;
        facts.push(
            t("events.facts.rareCatch", {
                treasure: t(CATCH_LABELS[options.treasure]).toLowerCase()
            })
        );
    }
    if (preset.kind === "xp-boost") {
        const options = preset.options as catalog.EventOptions<"xp-boost">;
        const extra = [
            options.perKill > 0 && t("events.facts.perKill", { count: options.perKill }),
            options.perOre > 0 && t("events.facts.perOre", { count: options.perOre })
        ].filter(Boolean);
        facts.push(t("events.facts.xpBoost", { extra: extra.join(` ${t("events.facts.and")} `) }));
    }
    if (preset.kind === "waves") {
        const options = preset.options as catalog.EventOptions<"waves">;
        facts[0] = t("events.facts.waves", {
            waves: options.waves,
            minutes: catalog.runMinutes(preset)
        });
        facts.push(
            t("events.facts.wavesScaling"),
            t("events.facts.wavesGear"),
            t("events.facts.wavesPoint"),
            t("events.facts.keepInventory")
        );
    }
    if (preset.kind === "meteor-shower") {
        const options = preset.options as catalog.EventOptions<"meteor-shower">;
        facts.push(
            t("events.facts.meteors", {
                meteors: options.meteors,
                size: options.size,
                seconds: Math.round(
                    catalog.meteorGap(catalog.runMinutes(preset) * 60_000, options.meteors) / 1000
                )
            }),
            t("events.facts.meteorsLand"),
            t("events.facts.pickaxes")
        );
    }
    if (catalog.playsOnStage(preset)) {
        const options = preset.options as { height: number };
        facts.push(
            preset.kind === "parkour"
                ? t("events.facts.parkour", {
                      jumps: (preset.options as catalog.EventOptions<"parkour">).jumps,
                      difficulty: t(
                          `events.difficulties.${(preset.options as catalog.EventOptions<"parkour">).difficulty}` as GameKey<"minecraft">
                      ),
                      height: options.height
                  })
                : t("events.facts.spleef", {
                      size: (preset.options as catalog.EventOptions<"spleef">).size * 2 + 1,
                      height: options.height
                  }),
            t("events.facts.joinCountdown", { seconds: catalog.JOIN_SECONDS }),
            t("events.facts.stageBuilt"),
            preset.kind === "spleef"
                ? t("events.facts.spleefShovel")
                : t("events.facts.parkourItems")
        );
    }
    if (preset.kind === "team-duel") {
        const options = preset.options as catalog.EventOptions<"team-duel">;
        facts.push(
            t("events.facts.duelJoin"),
            t("events.facts.duelKit", {
                kit: t(`events.kits.${options.kit}` as GameKey<"minecraft">),
                hearts: options.downHearts
            }),
            t("events.facts.duelKeepInventory"),
            t("events.facts.duelNeeds")
        );
    }
    if (preset.kind === "build-battle") {
        const options = preset.options as catalog.EventOptions<"build-battle">;
        facts.push(
            t("events.facts.buildJoin"),
            t(
                options.themeMode === "mine"
                    ? "events.facts.buildPlanMine"
                    : "events.facts.buildPlanBuiltIn",
                {
                    size: options.plotSize,
                    minutes: preset.minutes,
                    seconds: options.voteSeconds
                }
            ),
            t("events.facts.buildGlass"),
            t("events.facts.buildNeeds")
        );
    }
    if (catalog.playsInArena(preset)) {
        facts.push(t("events.facts.arena"));
    }
    if (preset.kind === "world-boss")
        facts.push(...worldBossFacts(t, preset.options as catalog.EventOptions<"world-boss">));
    {
        // What it holds of the world while it runs, and gives back after.
        const needs = catalog.worldNeeds(preset);
        if (preset.kind !== "blood-moon" && (needs.time || needs.weather))
            facts.push(
                t("events.facts.world", {
                    time: needs.time ?? "none",
                    weather: needs.weather ?? "none"
                })
            );
    }
    if (catalog.needsOverworld(preset) && !catalog.playsOnStage(preset))
        facts.push(t("events.facts.overworld"));
    if (catalog.hasMinScore(preset)) {
        facts.push(
            t("events.facts.rankedFrom", {
                score: catalog.minScoreOf(preset),
                unit: kindUnit(t, preset.kind)
            })
        );
    }
    if (settings) {
        const needed = catalog.activeNeeded(preset, settings);
        facts.push(t("events.facts.startsWith", { count: needed }));
    }
    if (catalog.needsHostileMobs(preset)) {
        facts.push(t("events.facts.hostileMobs"));
    }
    if (info.competitive) {
        facts.push(
            catalog.afkCounts(preset) ? t("events.facts.unrankedAfk") : t("events.facts.unranked")
        );
    }
    if (info.competitive) {
        const places = podiumPrizes(t, preset.rewards);
        const everybody =
            places.length > 0 ? t("events.facts.takingPart") : t("events.facts.everybody");
        const given = givesSomething(preset.rewards.everyone)
            ? [...places, [everybody, preset.rewards.everyone] as const]
            : places;
        facts.push(
            given.length > 0
                ? t("events.facts.prizes", {
                      list: given
                          .map(([place, reward]) => `${place}: ${rewardText(t, reward)}`)
                          .join("; ")
                  })
                : t("events.facts.noPrizes")
        );
    }
    return (
        <div className="mt-2 flex flex-col gap-1 rounded-md bg-muted/40 px-3 py-2 text-xs">
            <p className="text-foreground">{kindSummary(t, preset.kind)}</p>
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
    const t = useGameText("minecraft");
    const schemaText = useSchemaText();
    const display = useDisplayFormat();
    const [view, setView] = useState<EventsView | null>(null);
    const [draft, setDraft] = useState<catalog.EventsConfig | null>(null);
    // What this tab last read, before the paint and never over a live answer.
    useKeptSnapshot<EventsView>(snapshotKey(installedAppId), SNAPSHOT_MS, (kept) => {
        setView((current) => current ?? kept.value);
        setDraft((current) => current ?? kept.value.config);
    });
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
                    } else setError(answer.error ?? t("events.errors.read"));
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
        // Ticking for the event on, and for the countdown to the next drawn one.
        if (!running && !view?.nextRandomAt) return;
        const timer = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, [running, view?.nextRandomAt]);

    const checked = useMemo(
        () => (draft ? catalog.eventsConfigSchema.safeParse(draft) : null),
        [draft]
    );
    const problem =
        checked && !checked.success
            ? (schemaText(checked.error.issues[0]?.message) ?? t("events.errors.check"))
            : null;

    function save(): void {
        if (!draft || problem) return;
        setError(null);
        startTransition(async () => {
            const answer = await actions.saveEventsAction({ installedAppId, config: draft });
            if (!answer.view) {
                setError(answer.error ?? t("events.errors.save"));
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
                setError(answer.error ?? t("events.errors.start"));
                return;
            }
            accept(answer.view, false);
            setNote(t("events.starting", { name: preset.name }));
        });
    }

    /** What the last press of Run a random event left out, and why. */
    const [skipped, setSkipped] = useState<{ name: string; reason: string }[] | null>(null);

    function runRandom(): void {
        setError(null);
        setNote(null);
        setSkipped(null);
        startTransition(async () => {
            const answer = await actions.runRandomAction(installedAppId);
            if (!answer.view) {
                setError(answer.error ?? t("events.errors.start"));
                return;
            }
            accept(answer.view, false);
            setSkipped(answer.skipped ?? []);
            if (answer.picked) setNote(t("events.drawnNow", { name: answer.picked }));
            else setError(t("events.noneCanStart"));
        });
    }

    async function cancel(): Promise<void> {
        const sure = await confirm({
            title: t("events.callOffTheEvent"),
            description: t("events.itStopsNowNobodyWins"),
            confirmLabel: t("events.callItOff")
        });
        if (!sure) return;
        startTransition(async () => {
            const answer = await actions.cancelEventAction(installedAppId);
            if (answer.view) accept(answer.view, false);
            else setError(answer.error ?? t("events.errors.cancel"));
        });
    }

    function startNow(): void {
        startTransition(async () => {
            const answer = await actions.startNowAction(installedAppId);
            if (answer.view) accept(answer.view, false);
            else setError(answer.error ?? t("events.errors.startNow"));
        });
    }

    async function remove(preset: catalog.EventPreset): Promise<void> {
        const sure = await confirm({
            title: t("events.deleteTitle", { name: preset.name }),
            description: t("events.itAlsoComesOffThe"),
            confirmLabel: t("events.delete")
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
            title: t("events.forgetPrizeTitle", { name: player }),
            description: t("events.itIsNotGivenWhen"),
            confirmLabel: t("events.forgetIt")
        });
        if (!sure) return;
        startTransition(async () => {
            const answer = await actions.forgetPrizeAction({ installedAppId, pendingId: id });
            if (answer.view) accept(answer.view, false);
            else setError(answer.error ?? t("events.errors.forgetPrize"));
        });
    }

    function giveBackStash(id: string, player: string): void {
        startTransition(async () => {
            const answer = await actions.retryStashAction({ installedAppId, id });
            if (!answer.view) {
                setError(answer.error ?? t("events.errors.stashRetry"));
                return;
            }
            accept(answer.view, false);
            if (answer.outcome === "done") setNote(t("events.givenBack", { name: player }));
            else if (answer.outcome === "offline")
                setError(t("events.stashOffline", { name: player }));
            else if (answer.outcome === "later") setError(t("events.stashLater", { name: player }));
            else setError(t("events.stashStillFailed", { name: player }));
        });
    }

    async function dismissStash(id: string, player: string): Promise<void> {
        const sure = await confirm({
            title: t("events.dismissStashTitle", { name: player }),
            description: t("events.dismissStashHint"),
            confirmLabel: t("events.dismissIt")
        });
        if (!sure) return;
        startTransition(async () => {
            const answer = await actions.dismissStashAction({ installedAppId, id });
            if (answer.view) accept(answer.view, false);
            else setError(answer.error ?? t("events.errors.stashDismiss"));
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
                            <p className="text-sm font-medium">{t("events.now")}</p>
                            {!view ? (
                                <ui.Skeleton className="mt-1 h-4 w-56" />
                            ) : view.run ? (
                                <p className="text-sm">
                                    <span className="font-medium">{view.run.name}</span>
                                    <span className="text-muted-foreground">
                                        {" - "}
                                        {view.run.cancelling
                                            ? t("events.beingCalledOff")
                                            : view.run.phase === "countdown"
                                              ? t("events.startsIn", {
                                                    time: clock(view.run.startsAt - now)
                                                })
                                              : t("events.timeLeft", {
                                                    time: clock(view.run.endsAt - now)
                                                })}
                                        {" - "}
                                        {t(TRIGGER_LABEL[view.run.trigger]).toLowerCase()}
                                    </span>
                                </p>
                            ) : (
                                <p className="text-sm text-muted-foreground">
                                    {t("events.noEventIsOn")}
                                    {view.players
                                        ? ` ${t("events.onServer", { online: view.players.online, active: view.players.active })}`
                                        : ""}
                                </p>
                            )}
                        </div>
                        {view?.run && canManage && !view.run.cancelling && (
                            <div className="flex flex-wrap gap-2">
                                {view.run.phase === "countdown" && (
                                    <ui.Button size="sm" disabled={pending} onClick={startNow}>
                                        <FastForward className="size-4" />
                                        {t("events.startNow")}
                                    </ui.Button>
                                )}
                                <ui.Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={pending}
                                    onClick={() => void cancel()}
                                >
                                    <Square className="size-4" />
                                    {t("events.callOff")}
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
                                        {one.score} {kindUnit(t, view.run!.kind)}
                                    </span>
                                </li>
                            ))}
                        </ol>
                    )}
                    {view && settings?.random.enabled && (
                        <DrawStatus
                            view={view}
                            now={now}
                            t={t}
                            schemaText={schemaText}
                            dateTime={(at) => display.dateTime(at)}
                        />
                    )}
                    {view && !view.run && canManage && settings && settings.random.pool.length > 0 && (
                        <div className="flex flex-col gap-2">
                            <div>
                                <ui.Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={pending || dirty}
                                    title={dirty ? t("events.saveFirst") : undefined}
                                    onClick={runRandom}
                                >
                                    <Dices className="size-4" />
                                    {t("events.runRandom")}
                                </ui.Button>
                            </div>
                            {skipped && skipped.length > 0 && (
                                <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                                    {skipped.map((one) => (
                                        <li key={one.name} className="min-w-0 truncate" title={schemaText(one.reason) ?? ""}>
                                            {t("events.skippedOne", {
                                                name: one.name,
                                                reason: lowerFirst(schemaText(one.reason) ?? "")
                                            })}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </ui.CardBody>
            </ui.Card>

            {/* The events this server has. */}
            <ui.Card>
                <ui.CardBody className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-sm font-medium">{t("events.events")}</p>
                        {!locked && draft && (
                            // A button that says what it does, opening the kinds
                            // with a line about each - rather than a select with
                            // nothing chosen, which read as a setting.
                            <ui.DropdownMenu>
                                <ui.DropdownMenuTrigger asChild>
                                    <ui.Button variant="secondary" size="sm">
                                        <Plus className="size-4" />
                                        {t("events.addAnEvent")}
                                    </ui.Button>
                                </ui.DropdownMenuTrigger>
                                <ui.DropdownMenuContent align="end" className="w-80">
                                    {catalog.EVENT_KINDS.map((kind) => (
                                        <ui.DropdownMenuItem
                                            key={kind}
                                            className="flex flex-col items-start gap-0.5"
                                            onSelect={() =>
                                                setEditing({
                                                    preset: catalog.newPreset(
                                                        kind,
                                                        newId(),
                                                        kindLabel(t, kind)
                                                    ),
                                                    isNew: true
                                                })
                                            }
                                        >
                                            <span className="text-sm">{kindLabel(t, kind)}</span>
                                            <span className="line-clamp-2 text-xs text-muted-foreground">
                                                {kindSummary(t, kind)}
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
                            {t("events.noEventsYetAddOne")}
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
                                            <PresetDetail preset={preset} />
                                        </div>
                                        <ui.Switch
                                            checked={preset.enabled}
                                            disabled={locked}
                                            aria-label={t("events.canComeRound", {
                                                name: preset.name
                                            })}
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
                                                aria-label={t("events.whatIs", {
                                                    name: preset.name
                                                })}
                                                title={t("events.whatIs", { name: preset.name })}
                                                aria-expanded={explained.has(preset.id)}
                                                onClick={() => explain(preset.id)}
                                            >
                                                <Info className="size-4" />
                                            </ui.Button>
                                            <ui.Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={t("events.runNow", {
                                                    name: preset.name
                                                })}
                                                title={
                                                    dirty
                                                        ? t("events.saveFirst")
                                                        : t("events.runNow", { name: preset.name })
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
                                                aria-label={t("events.editNamed", {
                                                    name: preset.name
                                                })}
                                                title={t("events.editNamed", { name: preset.name })}
                                                disabled={locked}
                                                onClick={() => setEditing({ preset, isNew: false })}
                                            >
                                                <Pencil className="size-4" />
                                            </ui.Button>
                                            <ui.Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={t("events.duplicateNamed", {
                                                    name: preset.name
                                                })}
                                                title={t("events.duplicateNamed", {
                                                    name: preset.name
                                                })}
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
                                                aria-label={t("events.deleteNamed", {
                                                    name: preset.name
                                                })}
                                                title={t("events.deleteNamed", {
                                                    name: preset.name
                                                })}
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
                        {t("events.theSwitchLetsAnEvent")}
                    </p>
                </ui.CardBody>
            </ui.Card>

            {/* When they come round on their own. */}
            <ui.Card>
                <ui.CardBody className="flex flex-col gap-4">
                    <div>
                        <p className="text-sm font-medium">{t("events.automaticEvents")}</p>
                        <p className="text-xs text-muted-foreground">
                            {t("events.anAutomaticEventOnlyStarts")}
                        </p>
                    </div>
                    {!settings ? (
                        <ui.Skeleton className="h-28 w-full" />
                    ) : (
                        <>
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">
                                        {t("events.playersPlayingAtLeast")}
                                    </span>
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
                                    <span className="font-medium">
                                        {t("events.idleAfterMinutes")}
                                    </span>
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
                                    <span className="font-medium">
                                        {t("events.warningBeforeItStarts")}
                                    </span>
                                    <ui.Select
                                        value={String(settings.countdownSeconds)}
                                        disabled={locked}
                                        aria-label={t("events.warningBeforeItStarts")}
                                        options={[
                                            { value: "0", label: t("events.none") },
                                            { value: "30", label: t("events.30Seconds") },
                                            { value: "60", label: t("events.1Minute") },
                                            { value: "120", label: t("events.2Minutes") },
                                            { value: "300", label: t("events.5Minutes") }
                                        ]}
                                        onValueChange={(value) =>
                                            changeSettings({ countdownSeconds: Number(value) })
                                        }
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">
                                        {t("events.whatPlayersRead")}
                                    </span>
                                    <ui.Select
                                        value={settings.language}
                                        disabled={locked}
                                        aria-label={t("events.whatPlayersRead")}
                                        options={[
                                            { value: "en", label: "English" }, // i18n-ignore: a language by its own name
                                            { value: "es", label: "Español" } // i18n-ignore: a language by its own name
                                        ]}
                                        onValueChange={(value) =>
                                            changeSettings({ language: value as catalog.Language })
                                        }
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">{t("events.timeZone")}</span>
                                    <ui.Input
                                        value={settings.timezone}
                                        disabled={locked}
                                        // i18n-ignore: a time zone by its own name
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
                                        <p className="text-sm font-medium">
                                            {t("events.randomEvents")}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {t("events.inTheHoursBelowAn")}
                                        </p>
                                    </div>
                                    <ui.Switch
                                        checked={settings.random.enabled}
                                        disabled={locked}
                                        aria-label={t("events.drawEventsAtRandom")}
                                        onChange={(enabled) => changeRandom({ enabled })}
                                    />
                                </div>
                                {settings.random.enabled && (
                                    <>
                                        <DayPicker
                                            days={settings.random.days}
                                            onChange={(days) => changeRandom({ days })}
                                        />
                                        <label className="flex items-center gap-3 text-sm">
                                            <ui.Switch
                                                checked={settings.random.from === settings.random.to}
                                                disabled={locked}
                                                aria-label={t("events.anyTimeOfDay")}
                                                onChange={(on) =>
                                                    changeRandom(
                                                        on
                                                            ? { from: "00:00", to: "00:00" }
                                                            : { from: "18:00", to: "23:00" }
                                                    )
                                                }
                                            />
                                            {t("events.anyTimeOfDay")}
                                        </label>
                                        <div className="grid gap-3 sm:grid-cols-4">
                                            {settings.random.from !== settings.random.to && (
                                            <>
                                            <label className="flex flex-col gap-1 text-sm">
                                                <span className="font-medium">
                                                    {t("events.from")}
                                                </span>
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
                                                <span className="font-medium">
                                                    {t("events.until")}
                                                </span>
                                                <ui.Input
                                                    type="time"
                                                    value={settings.random.to}
                                                    disabled={locked}
                                                    onChange={(event) =>
                                                        changeRandom({ to: event.target.value })
                                                    }
                                                />
                                            </label>
                                            </>
                                            )}
                                            <label className="flex flex-col gap-1 text-sm">
                                                <span className="font-medium">
                                                    {t("events.timeBetweenEventsAtLeast")}
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
                                                    {t("events.andAtMostMin")}
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
                                            <div className="flex flex-wrap items-center justify-between gap-2">
                                                <p className="text-sm font-medium">
                                                    {t("events.drawnFrom")}
                                                </p>
                                                <div className="flex gap-2">
                                                    <ui.Button
                                                        variant="ghost"
                                                        size="sm"
                                                        disabled={locked}
                                                        onClick={() =>
                                                            changeRandom({
                                                                pool: presets
                                                                    .filter((one) => one.enabled)
                                                                    .map(
                                                                        (one) =>
                                                                            settings.random.pool.find(
                                                                                (entry) => entry.presetId === one.id
                                                                            ) ?? { presetId: one.id, weight: 1 }
                                                                    )
                                                            })
                                                        }
                                                    >
                                                        {t("events.drawAll")}
                                                    </ui.Button>
                                                    <ui.Button
                                                        variant="ghost"
                                                        size="sm"
                                                        disabled={locked || settings.random.pool.length === 0}
                                                        onClick={() => changeRandom({ pool: [] })}
                                                    >
                                                        {t("events.drawNone")}
                                                    </ui.Button>
                                                </div>
                                            </div>
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
                                                            aria-label={t("events.drawNamed", {
                                                                name: preset.name
                                                            })}
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
                                                            {!preset.enabled &&
                                                                ` ${t("events.switchedOff")}`}
                                                        </span>
                                                        {entry && (
                                                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                                                {t("events.howOften")}
                                                                <ui.Select
                                                                    value={String(entry.weight)}
                                                                    disabled={locked}
                                                                    aria-label={t(
                                                                        "events.howOftenNamed",
                                                                        { name: preset.name }
                                                                    )}
                                                                    options={[
                                                                        {
                                                                            value: "1",
                                                                            label: t(
                                                                                "events.sometimes"
                                                                            )
                                                                        },
                                                                        {
                                                                            value: "3",
                                                                            label: t("events.often")
                                                                        },
                                                                        {
                                                                            value: "6",
                                                                            label: t(
                                                                                "events.veryOften"
                                                                            )
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
                                        <p className="text-sm font-medium">
                                            {t("events.atSetTimes")}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {t("events.skippedAndWrittenInThe")}
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
                                        {t("events.addATime")}
                                    </ui.Button>
                                </div>
                                {(draft?.schedules ?? []).length === 0 ? (
                                    <p className="text-xs text-muted-foreground">
                                        {t("events.noSetTimes")}
                                    </p>
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
                                                            aria-label={t("events.whichEvent")}
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
                                                        aria-label={t("events.at")}
                                                        disabled={locked}
                                                        value={entry.at}
                                                        onChange={(event) =>
                                                            update({ at: event.target.value })
                                                        }
                                                    />
                                                    <ui.Switch
                                                        checked={entry.enabled}
                                                        disabled={locked}
                                                        aria-label={t("events.on")}
                                                        onChange={(enabled) => update({ enabled })}
                                                    />
                                                    <ui.Button
                                                        variant="ghost"
                                                        size="icon-sm"
                                                        className="ml-auto"
                                                        aria-label={t("events.removeThisTime")}
                                                        title={t("events.removeThisTime")}
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
                        {error ?? (dirty ? (problem ?? t("events.unsavedChanges")) : note)}
                    </span>
                    {dirty && (
                        <div className="flex items-center gap-2">
                            <ui.Button
                                variant="ghost"
                                disabled={pending}
                                onClick={() => view && setDraft(view.config)}
                            >
                                {t("events.discard")}
                            </ui.Button>
                            <ui.Button
                                disabled={pending || problem !== null || locked}
                                onClick={save}
                            >
                                {pending && <Loader2 className="size-4 animate-spin" />}
                                {t("events.save")}
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
                            <p className="text-sm font-medium">{t("events.prizesWaiting")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("events.givenTheNextTimeEach")}
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
                                        title={rewardText(t, one.reward)}
                                    >
                                        {one.event} - {rewardText(t, one.reward)}
                                    </span>
                                    <ui.Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={t("events.forgetPrize", { name: one.player })}
                                        title={t("events.forgetPrize", { name: one.player })}
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

            {/* Players' own things an event could not give back whole. */}
            {view && (view.stashFailures ?? []).length > 0 && (
                <ui.Card>
                    <ui.CardBody className="flex flex-col gap-2">
                        <div>
                            <p className="text-sm font-medium">{t("events.thingsNotGivenBack")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("events.thingsNotGivenBackHint")}
                            </p>
                        </div>
                        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                            {(view.stashFailures ?? []).map((one) => {
                                const barrel = one.barrels[0];
                                const where =
                                    one.missing === 0
                                        ? ""
                                        : barrel
                                          ? t("events.stashStacks", {
                                                count: one.missing,
                                                x: barrel.x,
                                                y: barrel.y,
                                                z: barrel.z
                                            })
                                          : t("events.stashCount", { count: one.missing });
                                const levels =
                                    one.levels > 0
                                        ? t("events.stashLevels", { count: one.levels })
                                        : "";
                                // Written by this version as a word; before it, as a sentence.
                                const note =
                                    one.note === "notGiven" || one.note === "experience"
                                        ? t(`events.stashNote.${one.note}`)
                                        : one.note;
                                const detail = [one.event, where, levels, note]
                                    .filter(Boolean)
                                    .join(" - ");
                                return (
                                    <li
                                        key={one.id}
                                        className="flex items-center gap-3 px-3 py-2 text-sm"
                                    >
                                        <span className="font-medium">{one.player}</span>
                                        <span
                                            className="min-w-0 flex-1 truncate text-muted-foreground"
                                            title={detail}
                                        >
                                            {detail}
                                        </span>
                                        <ui.Button
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={t("events.giveBackNow")}
                                            title={t("events.giveBackNow")}
                                            disabled={!canManage || pending}
                                            onClick={() => giveBackStash(one.id, one.player)}
                                        >
                                            <RotateCcw className="size-4" />
                                        </ui.Button>
                                        <ui.Button
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={t("events.dismissStash", {
                                                name: one.player
                                            })}
                                            title={t("events.dismissStash", { name: one.player })}
                                            disabled={!canManage || pending}
                                            onClick={() => void dismissStash(one.id, one.player)}
                                        >
                                            <Trash2 className="size-4" />
                                        </ui.Button>
                                    </li>
                                );
                            })}
                        </ul>
                    </ui.CardBody>
                </ui.Card>
            )}

            {/* How the last ones went. */}
            <ui.Card>
                <ui.CardBody className="flex flex-col gap-2">
                    <p className="text-sm font-medium">{t("events.history")}</p>
                    {!view ? (
                        <ui.Skeleton className="h-16 w-full" />
                    ) : view.history.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {t("events.noEventsHaveRunOn")}
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
                                            {t(OUTCOME[entry.outcome].label)}
                                        </ui.Badge>
                                        <span className="text-xs text-muted-foreground">
                                            {t(TRIGGER_LABEL[entry.trigger])} -{" "}
                                            {display.dateTime(entry.startedAt)} -{" "}
                                            {t("events.participants", {
                                                count: entry.participants
                                            })}
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
                                            ` - ${t("events.disqualified", { names: entry.disqualified.join(", ") })}`}
                                        {(entry.keptOut ?? []).length > 0 &&
                                            ` - ${t("events.keptOut", {
                                                names: (entry.keptOut ?? [])
                                                    .map((one) =>
                                                        one.items.length > 0
                                                            ? `${one.name} (${one.items.map(catalog.itemName).join(", ")})`
                                                            : one.name
                                                    )
                                                    .join(", ")
                                            })}`}
                                    </p>
                                    {entry.search && (
                                        <p className="text-xs text-muted-foreground">
                                            {searchLine(t, entry.search)}
                                        </p>
                                    )}
                                    {(entry.delivered ?? []).length > 0 && (
                                        <p className="text-xs text-muted-foreground">
                                            {t("events.delivered", {
                                                list: (entry.delivered ?? [])
                                                    .map((one) =>
                                                        [
                                                            ...one.items.map(
                                                                (item) =>
                                                                    `${item.count} ${item.id.replace(/^minecraft:/, "")}${
                                                                        item.dropped > 0
                                                                            ? ` (${t("events.deliveredDropped", { count: item.dropped })})`
                                                                            : ""
                                                                    }`
                                                            ),
                                                            ...(one.levels > 0
                                                                ? [
                                                                      t("events.deliveredLevels", {
                                                                          count: one.levels
                                                                      })
                                                                  ]
                                                                : [])
                                                        ].join(", ")
                                                    )
                                                    .map(
                                                        (what, index) =>
                                                            `${entry.delivered[index]!.name}: ${what}`
                                                    )
                                                    .join("; ")
                                            })}
                                        </p>
                                    )}
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
