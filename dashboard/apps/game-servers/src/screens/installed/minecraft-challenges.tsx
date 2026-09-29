"use client";

/**
 * The Challenges tab: whether they run, today's, this week's and tomorrow's
 * draw, the season and the month's bingo card, community goals, where each
 * player stands, the settings and rewards, and every challenge explained.
 *
 * Everything that does not depend on the server's answer is drawn at once;
 * only the values wait. What is running is read again every half minute, so a
 * new day's draw appears without a reload, and an edit in progress is never
 * overwritten by a read.
 */

import * as ui from "@polaris/ui";
import { weekdayNames } from "@polaris/core";
import * as actions from "./challenges-actions";
import { hostUi } from "@polaris/app-host/client";
import { Info, Plus, Trash2 } from "lucide-react";
import * as parts from "./minecraft-challenges-parts";
import * as catalog from "../../lib/minecraft/challenges/catalog";
import * as settingsModule from "../../lib/minecraft/challenges/settings";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import type { ChallengesView, PoolView } from "../../lib/minecraft/challenges/challenges-service";
import {
    durationText,
    issueText,
    tierName,
    useChallengesText,
    type ChallengesT,
    type PanelLanguage
} from "./challenges-text";

const { useConfirm } = hostUi.confirmDialog;
const { useDisplayFormat } = hostUi.displayFormat;
const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;

const SNAPSHOT_MS = 30_000;
const snapshotKey = (installedAppId: string) => `minecraft-challenges:${installedAppId}`;
type Settings = settingsModule.ChallengeSettings;

function newId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function todayKey(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ layout

/** The parts of the tab, each on its own rather than stacked into one page. */
const SECTIONS = ["overview", "players", "goals", "settings", "rewards", "catalogue"] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_KEY = "minecraft-challenges:section";

function rememberedSection(): Section {
    try {
        const kept = localStorage.getItem(SECTION_KEY);
        return (SECTIONS as readonly string[]).includes(kept ?? "") ? (kept as Section) : "overview";
    } catch {
        return "overview";
    }
}

/** One number at the top, with what it means under it. Null is still loading. */
function Stat({ label, value, detail }: { label: string; value: string | null; detail: string | null }) {
    return (
        <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border px-3 py-2">
            <dt className="truncate text-xs text-muted-foreground" title={label}>
                {label}
            </dt>
            <dd className="text-lg font-semibold tabular-nums">
                {value ?? <ui.Skeleton className="mt-1 h-5 w-10" />}
            </dd>
            <dd className="truncate text-xs text-muted-foreground" title={detail ?? undefined}>
                {detail ?? <ui.Skeleton className="h-3 w-24" />}
            </dd>
        </div>
    );
}

/**
 * A group of settings: what it is about on the left, the controls on the right.
 * Twenty-five controls in one block was the part of this tab nobody could read.
 */
function Group({
    title,
    hint,
    children
}: {
    title: string;
    hint: string;
    children: React.ReactNode;
}) {
    return (
        <section className="grid gap-3 border-t border-border pt-4 first:border-t-0 first:pt-0 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-6">
            <div className="min-w-0">
                <p className="text-sm font-medium">{title}</p>
                <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
            <div className="flex min-w-0 flex-col gap-3">{children}</div>
        </section>
    );
}

// ------------------------------------------------------------------ the draw

function PoolTable({
    pool,
    layer,
    t,
    language,
    now
}: {
    pool: PoolView | null;
    layer: "daily" | "weekly";
    t: ChallengesT;
    language: PanelLanguage;
    now: number;
}) {
    const [explained, setExplained] = useState<string | null>(null);
    if (!pool) return <p className="text-sm text-muted-foreground">{t("draw.none")}</p>;
    return (
        <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
                {t("draw.endsIn", { time: durationText(t, pool.endsAt - now) })}
            </p>
            <PoolList
                entries={pool.entries}
                layer={layer}
                t={t}
                language={language}
                explained={explained}
                onExplain={setExplained}
            />
            {pool.refused.length > 0 && (
                <p className="text-xs text-muted-foreground">
                    {t("draw.refused", { count: pool.refused.length })}
                </p>
            )}
        </div>
    );
}

function PoolList({
    entries,
    layer,
    t,
    language,
    explained,
    onExplain
}: {
    entries: readonly (
        | PoolView["entries"][number]
        | (Omit<PoolView["entries"][number], "dealt" | "done"> & { dealt?: number; done?: number })
    )[];
    layer: "daily" | "weekly" | "card";
    t: ChallengesT;
    language: PanelLanguage;
    explained: string | null;
    onExplain: (id: string | null) => void;
}) {
    return (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {entries.map((entry) => {
                const template = catalog.templateOf(entry.template);
                if (!template) return null;
                const title = catalog.titleOf(template, entry.variant, entry.target, language);
                const key = `${entry.template}:${entry.tier}`;
                return (
                    <li key={key} className="flex flex-col px-3 py-2">
                        <div className="flex items-center gap-3">
                            <ui.Badge variant={parts.tierTone(entry.tier)}>
                                {tierName(t, layer, entry.tier)}
                            </ui.Badge>
                            <span className="min-w-0 flex-1 truncate text-sm" title={title}>
                                {title}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                                {catalog.CATEGORY_LABELS[template.category][language]}
                            </span>
                            {entry.dealt !== undefined && (
                                <span
                                    className="shrink-0 text-xs tabular-nums text-muted-foreground"
                                    title={t("draw.dealtDoneTitle")}
                                >
                                    {t("draw.dealtDone", {
                                        done: entry.done ?? 0,
                                        dealt: entry.dealt
                                    })}
                                </span>
                            )}
                            <ui.Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t("catalogue.what", { title })}
                                title={t("catalogue.what", { title })}
                                aria-expanded={explained === key}
                                onClick={() => onExplain(explained === key ? null : key)}
                            >
                                <Info className="size-4" />
                            </ui.Button>
                        </div>
                        {explained === key && (
                            <parts.ChallengeExplained
                                template={template}
                                t={t}
                                language={language}
                            />
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

// ------------------------------------------------------------------ the tab

export function MinecraftChallenges({
    installedAppId,
    canManage
}: {
    installedAppId: string;
    canManage: boolean;
}) {
    const { t, locale, language } = useChallengesText();
    const display = useDisplayFormat();
    const [view, setView] = useState<ChallengesView | null>(null);
    const [draft, setDraft] = useState<Settings | null>(null);
    useKeptSnapshot<ChallengesView>(snapshotKey(installedAppId), SNAPSHOT_MS, (kept) => {
        setView((current) => current ?? kept.value);
        setDraft((current) => current ?? kept.value.settings);
    });
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [drawTab, setDrawTab] = useState<"today" | "week" | "tomorrow">("today");
    const [section, setSection] = useState<Section>("overview");
    useEffect(() => {
        setSection(rememberedSection());
    }, []);
    const pick = (next: Section) => {
        setSection(next);
        try {
            localStorage.setItem(SECTION_KEY, next);
        } catch {
            // Only a convenience: the next visit opens on the summary.
        }
    };
    const [cardExplained, setCardExplained] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();
    const [now, setNow] = useState(() => Date.now());

    const accept = useCallback(
        (next: ChallengesView, replaceDraft: boolean) => {
            setView(next);
            writeSnapshot(snapshotKey(installedAppId), next);
            if (replaceDraft) setDraft(next.settings);
        },
        [installedAppId]
    );

    useEffect(() => {
        let alive = true;
        const read = () =>
            void actions
                .readChallengesAction(installedAppId)
                .then((answer) => {
                    if (!alive) return;
                    if (answer.view) {
                        setView(answer.view);
                        writeSnapshot(snapshotKey(installedAppId), answer.view);
                        setDraft((current) => current ?? answer.view!.settings);
                        setNow(Date.now());
                    } else setError(answer.error ?? null);
                })
                .catch(() => {
                    // Tried again on the next beat.
                });
        read();
        const timer = setInterval(read, 30_000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [installedAppId]);

    useEffect(() => {
        if (!note) return;
        const timer = setTimeout(() => setNote(null), 5_000);
        return () => clearTimeout(timer);
    }, [note]);

    const dirty =
        view !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(view.settings);
    const checked = useMemo(
        () => (draft ? settingsModule.settingsSchema.safeParse(draft) : null),
        [draft]
    );
    const problem =
        checked && !checked.success ? issueText(t, checked.error.issues[0]?.message) : null;
    const bedrock = view?.refusal === "bedrock";
    const locked = !canManage || bedrock;

    const change = (patch: Partial<Settings>) => {
        setDraft((current) => (current ? { ...current, ...patch } : current));
        setNote(null);
    };
    const nested = <K extends keyof Settings>(key: K, patch: Partial<Settings[K]>) =>
        setDraft((current) =>
            current ? { ...current, [key]: { ...(current[key] as object), ...patch } } : current
        );

    function save(): void {
        if (!draft || problem) return;
        setError(null);
        startTransition(async () => {
            const answer = await actions.saveChallengesAction({ installedAppId, settings: draft });
            if (!answer.view) {
                setError(answer.error ?? t("errors.saveFailed"));
                return;
            }
            accept(answer.view, true);
            setNote(t("actions.saved"));
        });
    }

    async function reset(name: string): Promise<void> {
        const sure = await confirm({
            title: t("players.resetTitle", { name }),
            description: t("players.resetBody"),
            confirmLabel: t("players.resetConfirm")
        });
        if (!sure) return;
        startTransition(async () => {
            const answer = await actions.resetChallengePlayerAction({
                installedAppId,
                player: name
            });
            if (answer.view) accept(answer.view, false);
            else setError(answer.error ?? t("errors.saveFailed"));
        });
    }

    const settings = draft;
    const communityTemplates = catalog.TEMPLATES.filter((one) => one.layers.includes("community"));
    const status = !view
        ? null
        : !view.settings.enabled
          ? t("status.off")
          : view.running
            ? t("status.running")
            : t("status.idle");

    return (
        <div className="flex flex-col gap-4">
            {confirmElement}
            {bedrock && (
                <ui.Card>
                    <ui.CardBody className="text-sm text-muted-foreground">
                        {t("status.bedrock")}
                    </ui.CardBody>
                </ui.Card>
            )}

            {/* What it is, whether it runs, and the numbers that say how it is going. */}
            <ui.Card>
                <ui.CardBody className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 max-w-2xl">
                            <p className="text-base font-semibold">{t("status.title")}</p>
                            <p className="text-sm text-muted-foreground">{t("status.intro")}</p>
                        </div>
                        <div className="flex items-center gap-3">
                            {status === null ? (
                                <ui.Skeleton className="h-5 w-24" />
                            ) : (
                                <ui.Badge variant={view?.running ? "success" : "neutral"}>
                                    {status}
                                </ui.Badge>
                            )}
                            {settings ? (
                                <ui.Switch
                                    checked={settings.enabled}
                                    disabled={locked}
                                    aria-label={t("status.on")}
                                    onChange={(enabled) => change({ enabled })}
                                />
                            ) : (
                                <ui.Skeleton className="h-5 w-9" />
                            )}
                        </div>
                    </div>
                    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        <Stat
                            label={t("stats.today")}
                            value={view ? String(view.daily?.entries.length ?? 0) : null}
                            detail={
                                view?.daily
                                    ? t("draw.endsIn", {
                                          time: durationText(t, view.daily.endsAt - now)
                                      })
                                    : view
                                      ? t("stats.notDrawn")
                                      : null
                            }
                        />
                        <Stat
                            label={t("stats.week")}
                            value={view ? String(view.weekly?.entries.length ?? 0) : null}
                            detail={
                                view?.weekly
                                    ? t("draw.endsIn", {
                                          time: durationText(t, view.weekly.endsAt - now)
                                      })
                                    : view
                                      ? t("stats.notDrawn")
                                      : null
                            }
                        />
                        <Stat
                            label={t("stats.season")}
                            value={view ? String(view.season.number) : null}
                            detail={view ? t("stats.daysLeft", { left: view.season.daysLeft }) : null}
                        />
                        <Stat
                            label={t("stats.players")}
                            value={view ? String(view.players.length) : null}
                            detail={
                                view
                                    ? view.waiting > 0
                                        ? t("status.waiting", { count: view.waiting })
                                        : t("stats.nothingWaiting")
                                    : null
                            }
                        />
                    </dl>
                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                        {view ? (
                            <span>
                                {view.version
                                    ? t("status.version", { version: view.version })
                                    : t("status.versionUnknown")}
                            </span>
                        ) : (
                            <ui.Skeleton className="h-4 w-40" />
                        )}
                        {!canManage && <span>{t("status.readOnly")}</span>}
                    </div>
                </ui.CardBody>
            </ui.Card>

            {/* One part at a time: a page of eight cards was a page nobody could read. */}
            <div className="-mx-1 overflow-x-auto px-1 no-scrollbar">
                <ui.SegmentedControl
                    value={section}
                    onValueChange={pick}
                    aria-label={t("nav.label")}
                    options={SECTIONS.map((value) => ({ value, label: t(`nav.${value}`) }))}
                />
            </div>

            {section === "overview" && (
                <>
                    {/* Today, this week, tomorrow. */}
                    <ui.Card>
                        <ui.CardBody className="flex flex-col gap-3">
                            <ui.SegmentedControl
                                value={drawTab}
                                onValueChange={setDrawTab}
                                aria-label={t("draw.today")}
                                options={[
                                    { value: "today", label: t("draw.today") },
                                    { value: "week", label: t("draw.week") },
                                    { value: "tomorrow", label: t("draw.tomorrow") }
                                ]}
                            />
                            {!view ? (
                                <div className="flex flex-col gap-2" aria-busy="true">
                                    <ui.Skeleton className="h-9 w-full" />
                                    <ui.Skeleton className="h-9 w-full" />
                                    <ui.Skeleton className="h-9 w-2/3" />
                                </div>
                            ) : drawTab === "today" ? (
                                <PoolTable
                                    pool={view.daily}
                                    layer="daily"
                                    t={t}
                                    language={language}
                                    now={now}
                                />
                            ) : drawTab === "week" ? (
                                <PoolTable
                                    pool={view.weekly}
                                    layer="weekly"
                                    t={t}
                                    language={language}
                                    now={now}
                                />
                            ) : (
                                <div className="flex flex-col gap-2">
                                    <p className="text-xs text-muted-foreground">
                                        {t("draw.tomorrowNote")}
                                    </p>
                                    <PoolList
                                        entries={view.tomorrow}
                                        layer="daily"
                                        t={t}
                                        language={language}
                                        explained={cardExplained}
                                        onExplain={setCardExplained}
                                    />
                                </div>
                            )}
                        </ui.CardBody>
                    </ui.Card>
                    {/* The season and the card. */}
                    <ui.Card>
                        <ui.CardBody className="flex flex-col gap-3">
                            <div>
                                <p className="text-sm font-medium">{t("season.title")}</p>
                                {view ? (
                                    <p className="text-xs text-muted-foreground">
                                        {t("season.line", {
                                            number: view.season.number,
                                            start: view.season.startDay,
                                            end: view.season.endDay,
                                            left: view.season.daysLeft
                                        })}
                                    </p>
                                ) : (
                                    <ui.Skeleton className="mt-1 h-4 w-72" />
                                )}
                            </div>
                            <div className="grid gap-4 lg:grid-cols-2">
                                <div className="flex flex-col gap-2">
                                    <p className="text-xs font-medium text-muted-foreground">
                                        {t("season.card")}
                                    </p>
                                    {!view ? (
                                        <ui.Skeleton className="h-40 w-full" />
                                    ) : view.card && view.card.entries.length > 0 ? (
                                        <div className="grid grid-cols-3 gap-2">
                                            {view.card.entries.map((entry, index) => {
                                                const template = catalog.templateOf(entry.template);
                                                if (!template) return <div key={index} />;
                                                const title = catalog.titleOf(
                                                    template,
                                                    entry.variant,
                                                    entry.target,
                                                    language
                                                );
                                                return (
                                                    <div
                                                        key={index}
                                                        className="flex min-h-20 flex-col justify-between gap-1 rounded-md border border-border p-2"
                                                    >
                                                        <span
                                                            className="line-clamp-3 text-xs"
                                                            title={title}
                                                        >
                                                            {title}
                                                        </span>
                                                        <span className="text-[11px] tabular-nums text-muted-foreground">
                                                            {t("draw.dealtDone", {
                                                                done: entry.done,
                                                                dealt: entry.dealt
                                                            })}
                                                        </span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <p className="text-sm text-muted-foreground">
                                            {t("season.noCard")}
                                        </p>
                                    )}
                                </div>
                                <div className="flex flex-col gap-2">
                                    <p className="text-xs font-medium text-muted-foreground">
                                        {t("season.top")}
                                    </p>
                                    {!view ? (
                                        <ui.Skeleton className="h-24 w-full" />
                                    ) : view.players.filter((one) => one.points > 0).length === 0 ? (
                                        <p className="text-sm text-muted-foreground">
                                            {t("season.noOneYet")}
                                        </p>
                                    ) : (
                                        <ol className="flex flex-col gap-1 text-sm">
                                            {[...view.players]
                                                .filter((one) => one.points > 0)
                                                .sort((left, right) => right.points - left.points)
                                                .slice(0, 8)
                                                .map((one, index) => (
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
                                                        <span className="shrink-0 tabular-nums text-muted-foreground">
                                                            {t("season.tierPoints", {
                                                                tier: one.tier,
                                                                points: one.points
                                                            })}
                                                        </span>
                                                    </li>
                                                ))}
                                        </ol>
                                    )}
                                    {view && view.seasons.length > 0 && (
                                        <div className="flex flex-col gap-1">
                                            <p className="text-xs font-medium text-muted-foreground">
                                                {t("season.past")}
                                            </p>
                                            {view.seasons.slice(0, 5).map((one) => (
                                                <p key={one.key} className="text-xs text-muted-foreground">
                                                    {one.champions.length > 0
                                                        ? t("season.pastLine", {
                                                              season: one.key.split("#")[1] ?? one.key,
                                                              names: one.champions.join(", ")
                                                          })
                                                        : t("season.pastNobody", {
                                                              season: one.key.split("#")[1] ?? one.key
                                                          })}
                                                </p>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </ui.CardBody>
                    </ui.Card>
                </>
            )}
            {section === "players" && (
                <>
                    {/* Every player. */}
                    <ui.Card>
                        <ui.CardBody className="flex flex-col gap-3">
                            <div>
                                <p className="text-sm font-medium">{t("players.title")}</p>
                                <p className="text-xs text-muted-foreground">{t("players.intro")}</p>
                            </div>
                            {!view ? (
                                <div className="flex flex-col gap-2" aria-busy="true">
                                    <ui.Skeleton className="h-8 w-full" />
                                    <ui.Skeleton className="h-8 w-full" />
                                </div>
                            ) : (
                                <parts.PlayersTable
                                    rows={view.players}
                                    t={t}
                                    language={language}
                                    locked={locked}
                                    onReset={(name) => void reset(name)}
                                    dateTime={(at) => display.dateTime(at)}
                                />
                            )}
                        </ui.CardBody>
                    </ui.Card>
                </>
            )}
            {section === "goals" && (
                <>
                    {/* Community goals. */}
                    <ui.Card>
                        <ui.CardBody className="flex flex-col gap-3">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0 max-w-2xl">
                                    <p className="text-sm font-medium">{t("goals.title")}</p>
                                    <p className="text-xs text-muted-foreground">{t("goals.intro")}</p>
                                </div>
                                {settings && !locked && settings.community.goals.length < 20 && (
                                    <ui.Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() =>
                                            nested("community", {
                                                goals: [
                                                    ...settings.community.goals,
                                                    {
                                                        id: newId(),
                                                        template: "M1",
                                                        target: 2000,
                                                        start: todayKey(),
                                                        days: 7,
                                                        minShare: 2,
                                                        rewards: [1, 2, 3, 4, 5].map((tier) => ({
                                                            points: tier * 10,
                                                            levels: tier + 1,
                                                            items: []
                                                        }))
                                                    }
                                                ]
                                            })
                                        }
                                    >
                                        <Plus className="size-4" />
                                        {t("goals.add")}
                                    </ui.Button>
                                )}
                            </div>
                            {settings && (
                                <label className="flex items-center justify-between gap-3 text-sm">
                                    <span>{t("goals.auto")}</span>
                                    <ui.Switch
                                        checked={settings.community.auto}
                                        disabled={locked}
                                        aria-label={t("goals.auto")}
                                        onChange={(auto) => nested("community", { auto })}
                                    />
                                </label>
                            )}
                            {!view ? (
                                <ui.Skeleton className="h-12 w-full" />
                            ) : view.goals.length === 0 ? (
                                <p className="text-sm text-muted-foreground">{t("goals.none")}</p>
                            ) : (
                                <ul className="flex flex-col gap-2">
                                    {view.goals.map((goal) => {
                                        const template = catalog.templateOf(goal.template);
                                        if (!template) return null;
                                        const title = catalog.titleOf(
                                            template,
                                            goal.variant,
                                            goal.target,
                                            language
                                        );
                                        const share =
                                            goal.target > 0 ? Math.min(1, goal.total / goal.target) : 0;
                                        const top = Object.values(goal.shares)
                                            .sort((left, right) => right.value - left.value)
                                            .slice(0, 5);
                                        return (
                                            <li
                                                key={goal.id}
                                                className="flex flex-col gap-1 rounded-md border border-border p-3"
                                            >
                                                <div className="flex flex-wrap items-center justify-between gap-2">
                                                    <span
                                                        className="min-w-0 truncate text-sm font-medium"
                                                        title={title}
                                                    >
                                                        {title}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground">
                                                        {t("goals.state", {
                                                            state: goal.finished
                                                                ? "ended"
                                                                : goal.auto
                                                                  ? "drawn"
                                                                  : "running"
                                                        })}
                                                        {" - "}
                                                        {goal.tier === 0
                                                            ? t("goals.noTier")
                                                            : t("goals.tierN", { tier: goal.tier })}
                                                    </span>
                                                </div>
                                                <div className="h-2 overflow-hidden rounded-full bg-muted">
                                                    <div
                                                        className="h-full rounded-full bg-primary"
                                                        style={{ width: `${Math.round(share * 100)}%` }}
                                                    />
                                                </div>
                                                <p className="text-xs tabular-nums text-muted-foreground">
                                                    {t("goals.progress", {
                                                        total: parts.targetText(
                                                            t,
                                                            template,
                                                            goal.total,
                                                            language
                                                        ),
                                                        target: parts.targetText(
                                                            t,
                                                            template,
                                                            goal.target,
                                                            language
                                                        )
                                                    })}
                                                </p>
                                                {top.length > 0 && (
                                                    <p className="min-w-0 truncate text-xs text-muted-foreground">
                                                        {t("goals.top", {
                                                            names: top
                                                                .map(
                                                                    (one) =>
                                                                        `${one.name} (${parts.targetText(t, template, one.value, language)})`
                                                                )
                                                                .join(", ")
                                                        })}
                                                    </p>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                            {settings && settings.community.goals.length > 0 && (
                                <ul className="flex flex-col gap-3">
                                    {settings.community.goals.map((goal, index) => {
                                        const update = (patch: Partial<settingsModule.Goal>) =>
                                            nested("community", {
                                                goals: settings.community.goals.map((one, at) =>
                                                    at === index ? { ...one, ...patch } : one
                                                )
                                            });
                                        return (
                                            <li
                                                key={goal.id}
                                                className="flex flex-col gap-3 rounded-md border border-border p-3"
                                            >
                                                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                                                    <label className="flex flex-col gap-1 text-sm lg:col-span-2">
                                                        <span className="font-medium">
                                                            {t("goals.challenge")}
                                                        </span>
                                                        <ui.Select
                                                            value={goal.template}
                                                            disabled={locked}
                                                            aria-label={t("goals.challenge")}
                                                            options={communityTemplates.map((one) => ({
                                                                value: one.id,
                                                                label: catalog.shapeOf(one, language)
                                                            }))}
                                                            onValueChange={(value) =>
                                                                update({ template: value })
                                                            }
                                                        />
                                                    </label>
                                                    <label className="flex flex-col gap-1 text-sm">
                                                        <span className="font-medium">
                                                            {t("goals.target")}
                                                        </span>
                                                        <ui.Input
                                                            type="number"
                                                            min={1}
                                                            disabled={locked}
                                                            value={
                                                                Number.isFinite(goal.target)
                                                                    ? catalog.inUnit(
                                                                          catalog.templateOf(
                                                                              goal.template
                                                                          ) ?? catalog.TEMPLATES[0]!,
                                                                          goal.target
                                                                      )
                                                                    : ""
                                                            }
                                                            onChange={(event) => {
                                                                const template = catalog.templateOf(
                                                                    goal.template
                                                                );
                                                                const divisor = template
                                                                    ? catalog.UNIT_DIVISOR[template.unit]
                                                                    : 1;
                                                                update({
                                                                    target: Math.round(
                                                                        parts.numberOf(event.target.value) *
                                                                            divisor
                                                                    )
                                                                });
                                                            }}
                                                        />
                                                    </label>
                                                    <label className="flex flex-col gap-1 text-sm">
                                                        <span className="font-medium">
                                                            {t("goals.start")}
                                                        </span>
                                                        <ui.Input
                                                            type="date"
                                                            disabled={locked}
                                                            value={goal.start}
                                                            onChange={(event) =>
                                                                update({ start: event.target.value })
                                                            }
                                                        />
                                                    </label>
                                                    <label className="flex flex-col gap-1 text-sm">
                                                        <span className="font-medium">
                                                            {t("goals.days")}
                                                        </span>
                                                        <ui.Input
                                                            type="number"
                                                            min={1}
                                                            max={31}
                                                            disabled={locked}
                                                            value={
                                                                Number.isFinite(goal.days) ? goal.days : ""
                                                            }
                                                            onChange={(event) =>
                                                                update({
                                                                    days: parts.numberOf(event.target.value)
                                                                })
                                                            }
                                                        />
                                                    </label>
                                                    <label className="flex flex-col gap-1 text-sm">
                                                        <span className="font-medium">
                                                            {t("goals.share")}
                                                        </span>
                                                        <ui.Input
                                                            type="number"
                                                            min={0}
                                                            max={50}
                                                            step={0.5}
                                                            disabled={locked}
                                                            value={
                                                                Number.isFinite(goal.minShare)
                                                                    ? goal.minShare
                                                                    : ""
                                                            }
                                                            onChange={(event) =>
                                                                update({
                                                                    minShare: parts.numberOf(
                                                                        event.target.value
                                                                    )
                                                                })
                                                            }
                                                        />
                                                    </label>
                                                </div>
                                                <p className="text-xs font-medium text-muted-foreground">
                                                    {t("goals.tiers")}
                                                </p>
                                                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                                                    {goal.rewards.map((reward, tier) => (
                                                        <parts.PayoutEditor
                                                            key={tier}
                                                            label={t("goals.tierN", { tier: tier + 1 })}
                                                            value={reward}
                                                            t={t}
                                                            locked={locked}
                                                            onChange={(next) =>
                                                                update({
                                                                    rewards: goal.rewards.map((one, at) =>
                                                                        at === tier ? next : one
                                                                    )
                                                                })
                                                            }
                                                        />
                                                    ))}
                                                </div>
                                                {!locked && (
                                                    <div>
                                                        <ui.Button
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() =>
                                                                nested("community", {
                                                                    goals: settings.community.goals.filter(
                                                                        (_, at) => at !== index
                                                                    )
                                                                })
                                                            }
                                                        >
                                                            <Trash2 className="size-4" />
                                                            {t("actions.remove")}
                                                        </ui.Button>
                                                    </div>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </ui.CardBody>
                    </ui.Card>
                </>
            )}
            {section === "settings" && (
                <>
                    {/* Settings. */}
                    <ui.Card>
                        <ui.CardBody className="flex flex-col gap-4">
                            {!settings ? (
                                <ui.Skeleton className="h-40 w-full" />
                            ) : (
                                <SettingsFields
                                    settings={settings}
                                    change={change}
                                    nested={nested}
                                    t={t}
                                    locale={locale}
                                    locked={locked}
                                />
                            )}
                        </ui.CardBody>
                    </ui.Card>
                </>
            )}
            {section === "rewards" && (
                <>
                    {/* Rewards. */}
                    <ui.Card>
                        <ui.CardBody className="flex flex-col gap-4">
                            <div>
                                <p className="text-sm font-medium">{t("rewards.title")}</p>
                                <p className="text-xs text-muted-foreground">{t("rewards.intro")}</p>
                            </div>
                            {!settings ? (
                                <ui.Skeleton className="h-40 w-full" />
                            ) : (
                                <RewardFields settings={settings} nested={nested} t={t} locked={locked} />
                            )}
                        </ui.CardBody>
                    </ui.Card>
                </>
            )}
            {section === "catalogue" && (
                <>
                    {settings ? (
                        <parts.CatalogueCard
                            settings={settings}
                            onChange={setDraft}
                            t={t}
                            language={language}
                            locked={locked}
                        />
                    ) : (
                        <ui.Card>
                            <ui.CardBody className="flex flex-col gap-3">
                                <div>
                                    <p className="text-sm font-medium">{t("catalogue.title")}</p>
                                    <p className="text-xs text-muted-foreground">{t("catalogue.intro")}</p>
                                </div>
                                <ui.Skeleton className="h-40 w-full" />
                            </ui.CardBody>
                        </ui.Card>
                    )}
                </>
            )}

            {/* Save bar: only while something changed. */}
            {(dirty || error || note) && (
                <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-elevated px-4 py-3 shadow-popover">
                    <p
                        className={ui.cn(
                            "text-sm",
                            error || problem ? "text-danger" : "text-muted-foreground"
                        )}
                    >
                        {error ?? problem ?? note ?? ""}
                    </p>
                    {dirty && !locked && (
                        <div className="flex gap-2">
                            <ui.Button
                                variant="secondary"
                                size="sm"
                                disabled={pending}
                                onClick={() => view && setDraft(view.settings)}
                            >
                                {t("actions.discard")}
                            </ui.Button>
                            <ui.Button
                                size="sm"
                                disabled={pending || problem !== null}
                                aria-disabled={problem !== null}
                                onClick={save}
                            >
                                {pending ? t("actions.saving") : t("actions.save")}
                            </ui.Button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ------------------------------------------------------------------ settings

function Toggle({
    label,
    checked,
    onChange,
    locked,
    hint
}: {
    label: string;
    checked: boolean;
    onChange: (value: boolean) => void;
    locked: boolean;
    hint?: string;
}) {
    return (
        <label className="flex items-start justify-between gap-3 text-sm">
            <span className="min-w-0">
                <span>{label}</span>
                {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
            </span>
            <ui.Switch checked={checked} disabled={locked} aria-label={label} onChange={onChange} />
        </label>
    );
}

function NumberField({
    label,
    value,
    onChange,
    locked,
    min,
    max,
    step
}: {
    label: string;
    value: number;
    onChange: (value: number) => void;
    locked: boolean;
    min: number;
    max: number;
    step?: number;
}) {
    return (
        <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{label}</span>
            <ui.Input
                type="number"
                min={min}
                max={max}
                step={step}
                disabled={locked}
                value={Number.isFinite(value) ? value : ""}
                onChange={(event) => onChange(parts.numberOf(event.target.value))}
            />
        </label>
    );
}

/** The groups the settings are read under. */
type SettingsGroup = "schedule" | "layers" | "difficulty" | "who" | "shown" | "cheats" | "season" | "shared";

function SettingsFields({
    settings,
    change,
    nested,
    t,
    locale,
    locked
}: {
    settings: Settings;
    change: (patch: Partial<Settings>) => void;
    nested: <K extends keyof Settings>(key: K, patch: Partial<Settings[K]>) => void;
    t: ChallengesT;
    locale: string;
    locked: boolean;
}) {
    const g = (key: SettingsGroup) => ({
        title: t(`settings.groups.${key}.title`),
        hint: t(`settings.groups.${key}.hint`)
    });
    return (
        <>
            <Group {...g("schedule")}>
                <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("settings.language")}</span>
                        <ui.Select
                            value={settings.language}
                            disabled={locked}
                            aria-label={t("settings.language")}
                            options={[
                                { value: "en", label: t("settings.english") },
                                { value: "es", label: t("settings.spanish") }
                            ]}
                            onValueChange={(value) => change({ language: value as "en" | "es" })}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("settings.timezone")}</span>
                        <ui.Input
                            value={settings.timezone}
                            disabled={locked}
                            // i18n-ignore: a zone id reads the same in every language
                            placeholder="Europe/Madrid"
                            onChange={(event) => change({ timezone: event.target.value })}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("settings.resetAt")}</span>
                        <ui.Input
                            type="time"
                            value={settings.resetAt}
                            disabled={locked}
                            onChange={(event) => change({ resetAt: event.target.value })}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("settings.weekDay")}</span>
                        <ui.Select
                            value={String(settings.weekDay)}
                            disabled={locked}
                            aria-label={t("settings.weekDay")}
                            options={weekdayNames(locale, "long").map((day, index) => ({
                                value: String(index),
                                label: day
                            }))}
                            onValueChange={(value) => change({ weekDay: Number(value) })}
                        />
                    </label>
                </div>
            </Group>

            <Group {...g("layers")}>
                <Toggle
                    label={t("settings.layerDaily")}
                    checked={settings.layers.daily}
                    locked={locked}
                    onChange={(daily) => nested("layers", { daily })}
                />
                <Toggle
                    label={t("settings.layerWeekly")}
                    checked={settings.layers.weekly}
                    locked={locked}
                    onChange={(weekly) => nested("layers", { weekly })}
                />
                <Toggle
                    label={t("settings.layerSeason")}
                    checked={settings.layers.season}
                    locked={locked}
                    onChange={(season) => nested("layers", { season })}
                />
                <Toggle
                    label={t("settings.layerCard")}
                    checked={settings.layers.card}
                    locked={locked}
                    onChange={(card) => nested("layers", { card })}
                />
                <Toggle
                    label={t("settings.layerCommunity")}
                    checked={settings.layers.community}
                    locked={locked}
                    onChange={(community) => nested("layers", { community })}
                />
            </Group>

            <Group {...g("difficulty")}>
                <div className="grid gap-3 sm:grid-cols-3">
                    <NumberField
                        label={t("settings.multiplier")}
                        value={settings.multiplier}
                        min={0.25}
                        max={4}
                        step={0.05}
                        locked={locked}
                        onChange={(multiplier) => change({ multiplier })}
                    />
                    <NumberField
                        label={t("settings.rerollsDaily")}
                        value={settings.rerolls.daily}
                        min={0}
                        max={5}
                        locked={locked}
                        onChange={(daily) => nested("rerolls", { daily })}
                    />
                    <NumberField
                        label={t("settings.rerollsWeekly")}
                        value={settings.rerolls.weekly}
                        min={0}
                        max={5}
                        locked={locked}
                        onChange={(weekly) => nested("rerolls", { weekly })}
                    />
                </div>
                <Toggle
                    label={t("settings.pace")}
                    hint={t("settings.paceHint")}
                    checked={settings.pace}
                    locked={locked}
                    onChange={(pace) => change({ pace })}
                />
            </Group>

            <Group {...g("who")}>
                <div className="grid gap-3 sm:grid-cols-3">
                    <NumberField
                        label={t("settings.minMinutes")}
                        value={settings.eligibility.minMinutes}
                        min={0}
                        max={600}
                        locked={locked}
                        onChange={(minMinutes) => nested("eligibility", { minMinutes })}
                    />
                </div>
                <Toggle
                    label={t("settings.linkedOnly")}
                    checked={settings.eligibility.linkedOnly}
                    locked={locked}
                    onChange={(linkedOnly) => nested("eligibility", { linkedOnly })}
                />
            </Group>

            <Group {...g("shown")}>
                <Toggle
                    label={t("settings.joinMessage")}
                    checked={settings.display.joinMessage}
                    locked={locked}
                    onChange={(joinMessage) => nested("display", { joinMessage })}
                />
                <Toggle
                    label={t("settings.actionBar")}
                    checked={settings.display.actionBar}
                    locked={locked}
                    onChange={(actionBar) => nested("display", { actionBar })}
                />
                <Toggle
                    label={t("settings.bossBar")}
                    checked={settings.display.bossBar}
                    locked={locked}
                    onChange={(bossBar) => nested("display", { bossBar })}
                />
            </Group>

            <Group {...g("cheats")}>
                <Toggle
                    label={t("settings.afk")}
                    checked={settings.antiExploit.afk}
                    locked={locked}
                    onChange={(afk) => nested("antiExploit", { afk })}
                />
                {settings.antiExploit.afk && (
                    <div className="grid gap-3 sm:grid-cols-3">
                        <NumberField
                            label={t("settings.afkMinutes")}
                            value={settings.antiExploit.afkMinutes}
                            min={1}
                            max={15}
                            locked={locked}
                            onChange={(afkMinutes) => nested("antiExploit", { afkMinutes })}
                        />
                    </div>
                )}
                <Toggle
                    label={t("settings.xray")}
                    checked={settings.antiExploit.xray}
                    locked={locked}
                    onChange={(xray) => nested("antiExploit", { xray })}
                />
                <Toggle
                    label={t("settings.caps")}
                    checked={settings.antiExploit.caps}
                    locked={locked}
                    onChange={(caps) => nested("antiExploit", { caps })}
                />
            </Group>

            <Group {...g("season")}>
                <div className="grid gap-3 sm:grid-cols-3">
                    <NumberField
                        label={t("settings.weeks")}
                        value={settings.season.weeks}
                        min={4}
                        max={8}
                        locked={locked}
                        onChange={(weeks) => nested("season", { weeks })}
                    />
                    <NumberField
                        label={t("settings.tiers")}
                        value={settings.season.tiers}
                        min={10}
                        max={100}
                        locked={locked}
                        onChange={(tiers) => nested("season", { tiers })}
                    />
                    <NumberField
                        label={t("settings.pointsPerTier")}
                        value={settings.season.pointsPerTier}
                        min={10}
                        max={10000}
                        locked={locked}
                        onChange={(pointsPerTier) => nested("season", { pointsPerTier })}
                    />
                    <NumberField
                        label={t("settings.levelsPerTier")}
                        value={settings.season.levelsPerTier}
                        min={0}
                        max={100}
                        locked={locked}
                        onChange={(levelsPerTier) => nested("season", { levelsPerTier })}
                    />
                    <NumberField
                        label={t("settings.dailyCap")}
                        value={settings.season.dailyCap}
                        min={10}
                        max={10000}
                        locked={locked}
                        onChange={(dailyCap) => nested("season", { dailyCap })}
                    />
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("settings.seasonStart")}</span>
                        <ui.Input
                            type="date"
                            value={settings.season.start}
                            disabled={locked}
                            onChange={(event) => nested("season", { start: event.target.value })}
                        />
                        <span className="text-xs text-muted-foreground">
                            {t("settings.seasonStartHint")}
                        </span>
                    </label>
                </div>
                <Toggle
                    label={t("settings.catchUp")}
                    checked={settings.season.catchUp}
                    locked={locked}
                    onChange={(catchUp) => nested("season", { catchUp })}
                />
            </Group>

            <Group {...g("shared")}>
                <Toggle
                    label={t("settings.shared")}
                    hint={t("settings.sharedHint")}
                    checked={settings.shared.enabled}
                    locked={locked}
                    onChange={(enabled) => nested("shared", { enabled })}
                />
                {settings.shared.enabled && (
                    <label className="flex max-w-sm flex-col gap-1 text-sm">
                        <span className="font-medium">{t("settings.group")}</span>
                        <ui.Input
                            value={settings.shared.group}
                            disabled={locked}
                            onChange={(event) => nested("shared", { group: event.target.value })}
                        />
                    </label>
                )}
            </Group>
        </>
    );
}

/** The groups the rewards are read under. */
type RewardGroup = "daily" | "weekly" | "bonus" | "streak" | "milestones";

function RewardFields({
    settings,
    nested,
    t,
    locked
}: {
    settings: Settings;
    nested: <K extends keyof Settings>(key: K, patch: Partial<Settings[K]>) => void;
    t: ChallengesT;
    locked: boolean;
}) {
    const rewards = settings.rewards;
    const set = (patch: Partial<Settings["rewards"]>) => nested("rewards", patch);
    const g = (key: RewardGroup) => ({
        title: t(`rewards.groups.${key}.title`),
        hint: t(`rewards.groups.${key}.hint`)
    });
    return (
        <>
            <Group {...g("daily")}>
                <div className="grid gap-2 lg:grid-cols-2 2xl:grid-cols-3">
                    {catalog.DIFFICULTIES.map((tier) => (
                        <parts.PayoutEditor
                            key={tier}
                            label={tierName(t, "daily", tier)}
                            value={rewards.daily[tier]}
                            t={t}
                            locked={locked}
                            onChange={(next) => set({ daily: { ...rewards.daily, [tier]: next } })}
                        />
                    ))}
                </div>
            </Group>
            <Group {...g("weekly")}>
                <div className="grid gap-2 lg:grid-cols-2 2xl:grid-cols-3">
                    {catalog.DIFFICULTIES.map((tier) => (
                        <parts.PayoutEditor
                            key={tier}
                            label={tierName(t, "weekly", tier)}
                            value={rewards.weekly[tier]}
                            t={t}
                            locked={locked}
                            onChange={(next) => set({ weekly: { ...rewards.weekly, [tier]: next } })}
                        />
                    ))}
                </div>
            </Group>
            <Group {...g("bonus")}>
                <div className="grid gap-2 lg:grid-cols-2 2xl:grid-cols-3">
                    <parts.PayoutEditor
                        label={t("rewards.sweepDaily")}
                        value={rewards.dailySweep}
                        t={t}
                        locked={locked}
                        onChange={(dailySweep) => set({ dailySweep })}
                    />
                    <parts.PayoutEditor
                        label={t("rewards.sweepWeekly")}
                        value={rewards.weeklySweep}
                        t={t}
                        locked={locked}
                        onChange={(weeklySweep) => set({ weeklySweep })}
                    />
                    <parts.PayoutEditor
                        label={t("rewards.square")}
                        value={rewards.square}
                        t={t}
                        locked={locked}
                        onChange={(square) => set({ square })}
                    />
                    <parts.PayoutEditor
                        label={t("rewards.line")}
                        value={rewards.line}
                        t={t}
                        locked={locked}
                        onChange={(line) => set({ line })}
                    />
                    <parts.PayoutEditor
                        label={t("rewards.card")}
                        value={rewards.card}
                        t={t}
                        locked={locked}
                        onChange={(card) => set({ card })}
                    />
                </div>
            </Group>
            <Group {...g("streak")}>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {rewards.streak.map((value, index) => (
                        <NumberField
                            key={index}
                            label={t("rewards.streakAt", {
                                days: catalog.STREAK_MILESTONES[index] ?? 0
                            })}
                            value={value}
                            min={0}
                            max={10000}
                            locked={locked}
                            onChange={(next) =>
                                set({
                                    streak: rewards.streak.map((one, at) => (at === index ? next : one))
                                })
                            }
                        />
                    ))}
                    <NumberField
                        label={t("rewards.comeback")}
                        value={rewards.comeback}
                        min={0}
                        max={10000}
                        locked={locked}
                        onChange={(comeback) => set({ comeback })}
                    />
                </div>
            </Group>
            <Group {...g("milestones")}>
                <div className="flex flex-col gap-2">
                    {settings.season.milestones.map((milestone, index) => {
                        const update = (patch: Partial<settingsModule.Milestone>) =>
                            nested("season", {
                                milestones: settings.season.milestones.map((one, at) =>
                                    at === index ? { ...one, ...patch } : one
                                )
                            });
                        return (
                            <div
                                key={index}
                                className="flex flex-col gap-2 rounded-md border border-border p-3 md:flex-row md:items-start"
                            >
                                <div className="w-24 shrink-0">
                                    <NumberField
                                        label={t("rewards.milestoneTier")}
                                        value={milestone.tier}
                                        min={1}
                                        max={100}
                                        locked={locked}
                                        onChange={(tier) => update({ tier })}
                                    />
                                </div>
                                <div className="w-24 shrink-0">
                                    <NumberField
                                        label={t("rewards.levels")}
                                        value={milestone.levels}
                                        min={0}
                                        max={100}
                                        locked={locked}
                                        onChange={(levels) => update({ levels })}
                                    />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <parts.ItemsEditor
                                        items={milestone.items}
                                        t={t}
                                        locked={locked}
                                        onChange={(next) => update({ items: next })}
                                    />
                                </div>
                                {!locked && (
                                    <ui.Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={t("actions.remove")}
                                        title={t("actions.remove")}
                                        onClick={() =>
                                            nested("season", {
                                                milestones: settings.season.milestones.filter(
                                                    (_, at) => at !== index
                                                )
                                            })
                                        }
                                    >
                                        <Trash2 className="size-4" />
                                    </ui.Button>
                                )}
                            </div>
                        );
                    })}
                    {!locked && settings.season.milestones.length < 20 && (
                        <div>
                            <ui.Button
                                variant="secondary"
                                size="sm"
                                onClick={() =>
                                    nested("season", {
                                        milestones: [
                                            ...settings.season.milestones,
                                            {
                                                tier: Math.min(
                                                    100,
                                                    Math.max(
                                                        0,
                                                        ...settings.season.milestones.map(
                                                            (one) => one.tier
                                                        )
                                                    ) + 5
                                                ),
                                                levels: 0,
                                                items: []
                                            }
                                        ]
                                    })
                                }
                            >
                                <Plus className="size-4" />
                                {t("rewards.addMilestone")}
                            </ui.Button>
                        </div>
                    )}
                </div>
            </Group>
        </>
    );
}
