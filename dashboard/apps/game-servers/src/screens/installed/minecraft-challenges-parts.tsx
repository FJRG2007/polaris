"use client";

/**
 * The pieces of the Challenges tab: what a challenge is, a reward's fields, a
 * community goal's editor, the players' table and the catalogue.
 */

import { useState } from "react";
import * as ui from "@polaris/ui";
import * as catalog from "../../lib/minecraft/challenges/catalog";
import { tierName, type ChallengesT, type PanelLanguage } from "./challenges-text";
import type * as settingsModule from "../../lib/minecraft/challenges/settings";
import { ChevronDown, ChevronRight, Info, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { PlayerRow, InstanceView } from "../../lib/minecraft/challenges/challenges-service";

type Settings = settingsModule.ChallengeSettings;
type Payout = settingsModule.Payout;

/** A number typed into a field; empty or unreadable is NaN, which the schema refuses. */
export function numberOf(text: string): number {
    const value = Number(text);
    return text.trim() === "" || !Number.isFinite(value) ? Number.NaN : value;
}

export function versionText(version: catalog.Version | undefined): string | null {
    return version ? version.join(".") : null;
}

/** A target in its unit, formatted for the reader. */
export function targetText(t: ChallengesT, template: catalog.Template, value: number, language: PanelLanguage): string {
    const shown = catalog.formatNumber(catalog.inUnit(template, value), language);
    return t(`unit.${template.unit}`, { value: shown });
}

export function tierTone(tier: catalog.Difficulty): "success" | "warning" | "danger" {
    return tier === "easy" ? "success" : tier === "medium" ? "warning" : "danger";
}

/**
 * What one challenge is, said in full: what counts, what stops it being farmed,
 * its targets at each difficulty and where it can be dealt.
 */
export function ChallengeExplained({
    template,
    t,
    language
}: {
    template: catalog.Template;
    t: ChallengesT;
    language: PanelLanguage;
}) {
    const targets = catalog.DIFFICULTIES.map((tier) => {
        const value = catalog.baseTarget(template, "daily", tier);
        return t("catalogue.targetAt", {
            tier: tierName(t, "daily", tier),
            value: value === null ? t("catalogue.noTarget") : targetText(t, template, value, language)
        });
    });
    const weekly = catalog.DIFFICULTIES.map((tier) => {
        const value = catalog.baseTarget(template, "weekly", tier);
        return t("catalogue.targetAt", {
            tier: tierName(t, "weekly", tier),
            value: value === null ? t("catalogue.noTarget") : targetText(t, template, value, language)
        });
    });
    const card = catalog.baseTarget(template, "card", "hard");
    const community = catalog.baseTarget(template, "community", "hard");
    const version = versionText(template.minVersion);
    return (
        <div className="mt-2 flex flex-col gap-1 rounded-md bg-muted/40 px-3 py-2 text-xs">
            <p className="text-foreground">
                <span className="font-medium">{t("catalogue.how")} </span>
                {template.how[language]}
            </p>
            <p className="text-muted-foreground">
                <span className="font-medium text-foreground">{t("catalogue.exploit")} </span>
                {template.exploit[language]}
            </p>
            <p className="text-muted-foreground">
                <span className="font-medium text-foreground">{t("catalogue.where")} </span>
                {template.layers.map((layer) => t(`layer.${layer}`)).join(", ")}
            </p>
            {template.layers.includes("daily") && (
                <p className="text-muted-foreground">
                    {t("catalogue.targetsIn", { layer: t("layer.daily"), targets: targets.join(" - ") })}
                </p>
            )}
            {template.layers.includes("weekly") && (
                <p className="text-muted-foreground">
                    {t("catalogue.targetsIn", { layer: t("layer.weekly"), targets: weekly.join(" - ") })}
                </p>
            )}
            {card !== null && (
                <p className="text-muted-foreground">
                    {t("catalogue.targetsIn", { layer: t("layer.card"), targets: targetText(t, template, card, language) })}
                </p>
            )}
            {community !== null && (
                <p className="text-muted-foreground">
                    {t("catalogue.targetsIn", { layer: t("layer.community"), targets: t("catalogue.perPlayer", { value: targetText(t, template, community, language) }) })}
                </p>
            )}
            {version && <p className="text-muted-foreground">{t("catalogue.needs", { version })}</p>}
            {template.uncertain && <p className="text-muted-foreground">{t("catalogue.uncertain")}</p>}
        </div>
    );
}

/** Points, levels and up to six items. */
export function PayoutEditor({
    label,
    value,
    onChange,
    t,
    locked,
    points = true
}: {
    label: string;
    value: Payout;
    onChange: (next: Payout) => void;
    t: ChallengesT;
    locked: boolean;
    points?: boolean;
}) {
    return (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <p className="text-sm font-medium">{label}</p>
            <div className="flex flex-wrap gap-2">
                {points && (
                    <label className="flex w-28 flex-col gap-1 text-xs">
                        <span className="text-muted-foreground">{t("rewards.points")}</span>
                        <ui.Input
                            type="number"
                            min={0}
                            max={10000}
                            disabled={locked}
                            value={Number.isFinite(value.points) ? value.points : ""}
                            onChange={(event) => onChange({ ...value, points: numberOf(event.target.value) })}
                        />
                    </label>
                )}
                <label className="flex w-28 flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">{t("rewards.levels")}</span>
                    <ui.Input
                        type="number"
                        min={0}
                        max={100}
                        disabled={locked}
                        value={Number.isFinite(value.levels) ? value.levels : ""}
                        onChange={(event) => onChange({ ...value, levels: numberOf(event.target.value) })}
                    />
                </label>
            </div>
            <ItemsEditor items={value.items} onChange={(items) => onChange({ ...value, items })} t={t} locked={locked} />
        </div>
    );
}

export function ItemsEditor({
    items,
    onChange,
    t,
    locked
}: {
    items: Payout["items"];
    onChange: (next: Payout["items"]) => void;
    t: ChallengesT;
    locked: boolean;
}) {
    return (
        <div className="flex flex-col gap-2">
            {items.map((item, index) => (
                <div key={index} className="flex items-center gap-2">
                    <ui.Input
                        className="min-w-0 flex-1"
                        value={item.id}
                        placeholder="minecraft:diamond"
                        aria-label={t("rewards.item")}
                        disabled={locked}
                        onChange={(event) =>
                            onChange(items.map((one, at) => (at === index ? { ...one, id: event.target.value } : one)))
                        }
                    />
                    <ui.Input
                        className="w-20"
                        type="number"
                        min={1}
                        max={256}
                        aria-label={t("rewards.count")}
                        disabled={locked}
                        value={Number.isFinite(item.count) ? item.count : ""}
                        onChange={(event) =>
                            onChange(items.map((one, at) => (at === index ? { ...one, count: numberOf(event.target.value) } : one)))
                        }
                    />
                    <ui.Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("rewards.removeItem")}
                        title={t("rewards.removeItem")}
                        disabled={locked}
                        onClick={() => onChange(items.filter((_, at) => at !== index))}
                    >
                        <Trash2 className="size-4" />
                    </ui.Button>
                </div>
            ))}
            {!locked && items.length < 6 && (
                <div>
                    <ui.Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onChange([...items, { id: "minecraft:diamond", count: 1 }])}
                    >
                        <Plus className="size-4" />
                        {t("rewards.addItem")}
                    </ui.Button>
                </div>
            )}
        </div>
    );
}

/** A progress bar for a challenge in a table. */
export function Progress({ value, max, done, voided }: { value: number; max: number; done: boolean; voided?: boolean }) {
    const share = max > 0 ? Math.min(1, value / max) : 0;
    return (
        <span className="inline-block h-1.5 w-12 overflow-hidden rounded-full bg-muted align-middle" aria-hidden="true">
            <span
                className={ui.cn("block h-full rounded-full", voided ? "bg-danger" : done ? "bg-success" : "bg-primary")}
                style={{ width: `${Math.round((voided ? 1 : share) * 100)}%` }}
            />
        </span>
    );
}

function instanceTitle(instance: InstanceView, language: PanelLanguage): string {
    const template = catalog.templateOf(instance.template);
    return template ? catalog.titleOf(template, instance.variant, instance.target, language) : instance.template;
}

function InstanceBars({ instances, t, language }: { instances: readonly InstanceView[]; t: ChallengesT; language: PanelLanguage }) {
    if (instances.length === 0) return <span className="text-foreground-subtle">-</span>;
    return (
        <span className="flex items-center gap-1">
            {instances.map((instance, index) => {
                const template = catalog.templateOf(instance.template);
                const label = t("players.progress", {
                    title: instanceTitle(instance, language),
                    progress: template ? targetText(t, template, instance.progress, language) : instance.progress,
                    target: template ? targetText(t, template, instance.target, language) : instance.target
                });
                return (
                    <span key={index} title={label} aria-label={label}>
                        <Progress value={instance.progress} max={instance.target} done={instance.done} voided={instance.voided} />
                    </span>
                );
            })}
        </span>
    );
}

/** Everybody dealt challenges, with where each of them stands. */
export function PlayersTable({
    rows,
    t,
    language,
    locked,
    onReset,
    dateTime
}: {
    rows: readonly PlayerRow[];
    t: ChallengesT;
    language: PanelLanguage;
    locked: boolean;
    onReset: (name: string) => void;
    dateTime: (at: number) => string;
}) {
    const [open, setOpen] = useState<string | null>(null);
    if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t("players.none")}</p>;
    return (
        <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
                <thead>
                    <tr className="text-left">
                        <th className="py-1 pr-3">{t("players.name")}</th>
                        <th className="py-1 pr-3">{t("players.daily")}</th>
                        <th className="py-1 pr-3">{t("players.weekly")}</th>
                        <th className="py-1 pr-3">{t("players.bingo")}</th>
                        <th className="py-1 pr-3">{t("players.pass")}</th>
                        <th className="py-1 pr-3">{t("players.streak")}</th>
                        <th className="py-1 pr-3">{t("players.lastSeen")}</th>
                        <th className="py-1" />
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {rows.map((row) => (
                        <PlayerLine
                            key={row.name}
                            row={row}
                            t={t}
                            language={language}
                            locked={locked}
                            open={open === row.name}
                            onToggle={() => setOpen((current) => (current === row.name ? null : row.name))}
                            onReset={() => onReset(row.name)}
                            dateTime={dateTime}
                        />
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function PlayerLine({
    row,
    t,
    language,
    locked,
    open,
    onToggle,
    onReset,
    dateTime
}: {
    row: PlayerRow;
    t: ChallengesT;
    language: PanelLanguage;
    locked: boolean;
    open: boolean;
    onToggle: () => void;
    onReset: () => void;
    dateTime: (at: number) => string;
}) {
    const all = [...row.daily, ...row.weekly, ...row.backlog];
    return (
        <>
            <tr>
                <td className="py-1.5 pr-3">
                    <button
                        type="button"
                        className="flex items-center gap-1 text-left font-medium hover:underline"
                        aria-expanded={open}
                        onClick={onToggle}
                    >
                        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                        <span className="truncate" title={row.name}>{row.name}</span>
                    </button>
                    {row.titles.length > 0 && <p className="text-xs text-muted-foreground">{row.titles[row.titles.length - 1]}</p>}
                </td>
                <td className="py-1.5 pr-3">
                    <InstanceBars instances={row.daily} t={t} language={language} />
                    {row.backlog.length > 0 && <span className="text-xs text-muted-foreground">{t("players.backlog", { count: row.backlog.length })}</span>}
                </td>
                <td className="py-1.5 pr-3">
                    <InstanceBars instances={row.weekly} t={t} language={language} />
                </td>
                <td className="py-1.5 pr-3 tabular-nums">{t("players.cardDone", { done: row.cardDone, total: 9 })}</td>
                <td className="py-1.5 pr-3 tabular-nums">
                    {t("season.tierPoints", { tier: row.tier, points: row.points })}
                </td>
                <td className="py-1.5 pr-3 tabular-nums">{row.streak}</td>
                <td className="py-1.5 pr-3 text-xs text-muted-foreground">{row.lastSeenAt ? dateTime(row.lastSeenAt) : t("players.never")}</td>
                <td className="py-1.5 text-right">
                    <ui.Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("players.reset", { name: row.name })}
                        title={t("players.reset", { name: row.name })}
                        disabled={locked}
                        onClick={onReset}
                    >
                        <RotateCcw className="size-4" />
                    </ui.Button>
                </td>
            </tr>
            {open && (
                <tr>
                    <td colSpan={8} className="pb-2">
                        <ul className="flex flex-col gap-1 rounded-md bg-muted/40 px-3 py-2 text-xs">
                            {all.map((instance, index) => {
                                const template = catalog.templateOf(instance.template);
                                return (
                                    <li key={index} className="flex items-center justify-between gap-3">
                                        <span className="min-w-0 truncate">{instanceTitle(instance, language)}</span>
                                        <span className="flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground">
                                            <Progress value={instance.progress} max={instance.target} done={instance.done} voided={instance.voided} />
                                            {template
                                                ? t("goals.progress", {
                                                      total: targetText(t, template, instance.progress, language),
                                                      target: targetText(t, template, instance.target, language)
                                                  })
                                                : t("goals.progress", { total: instance.progress, target: instance.target })}
                                        </span>
                                    </li>
                                );
                            })}
                            {all.length === 0 && <li className="text-muted-foreground">{t("players.nothingDealt")}</li>}
                        </ul>
                    </td>
                </tr>
            )}
        </>
    );
}

/** The catalogue: categories on or off and weighted, each challenge explained and switchable. */
export function CatalogueCard({
    settings,
    onChange,
    t,
    language,
    locked
}: {
    settings: Settings;
    onChange: (next: Settings) => void;
    t: ChallengesT;
    language: PanelLanguage;
    locked: boolean;
}) {
    const [explained, setExplained] = useState<ReadonlySet<string>>(() => new Set());
    const [openCategory, setOpenCategory] = useState<catalog.Category | null>(null);
    const toggle = (id: string) =>
        setExplained((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    return (
        <ui.Card>
            <ui.CardBody className="flex flex-col gap-3">
                <div>
                    <p className="text-sm font-medium">{t("catalogue.title")}</p>
                    <p className="text-xs text-muted-foreground">{t("catalogue.intro")}</p>
                </div>
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {catalog.CATEGORIES.map((category) => {
                        const templates = catalog.TEMPLATES.filter((one) => one.category === category);
                        const state = settings.categories[category];
                        const open = openCategory === category;
                        return (
                            <li key={category} className="flex flex-col px-3 py-2">
                                <div className="flex flex-wrap items-center gap-3">
                                    <button
                                        type="button"
                                        className="flex min-w-0 flex-1 items-center gap-1 text-left text-sm font-medium"
                                        aria-expanded={open}
                                        onClick={() => setOpenCategory(open ? null : category)}
                                    >
                                        {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
                                        <span className="truncate">{catalog.CATEGORY_LABELS[category][language]}</span>
                                        <span className="text-xs font-normal text-muted-foreground">{t("catalogue.count", { count: templates.length })}</span>
                                    </button>
                                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                        {t("catalogue.weight")}
                                        <ui.Input
                                            className="w-16"
                                            type="number"
                                            min={0}
                                            max={5}
                                            step={0.5}
                                            disabled={locked}
                                            value={Number.isFinite(state.weight) ? state.weight : ""}
                                            onChange={(event) =>
                                                onChange({
                                                    ...settings,
                                                    categories: { ...settings.categories, [category]: { ...state, weight: numberOf(event.target.value) } }
                                                })
                                            }
                                        />
                                    </label>
                                    <ui.Switch
                                        checked={state.enabled}
                                        disabled={locked}
                                        aria-label={catalog.CATEGORY_LABELS[category][language]}
                                        onChange={(enabled) =>
                                            onChange({ ...settings, categories: { ...settings.categories, [category]: { ...state, enabled } } })
                                        }
                                    />
                                </div>
                                {open && (
                                    <ul className="mt-2 flex flex-col gap-1">
                                        {templates.map((template) => {
                                            const title = catalog.titleOf(
                                                template,
                                                template.variants?.[0]?.key ?? null,
                                                catalog.baseTarget(template, "daily", "medium") ??
                                                    catalog.baseTarget(template, "weekly", "easy") ??
                                                    catalog.baseTarget(template, "card", "hard") ??
                                                    1,
                                                language
                                            );
                                            const on = !settings.disabled.includes(template.id);
                                            return (
                                                <li key={template.id} className="flex flex-col rounded-md px-2 py-1 hover:bg-muted/40">
                                                    <div className="flex items-center gap-2">
                                                        <span className="w-9 shrink-0 font-mono text-xs text-foreground-subtle">{template.id}</span>
                                                        <span className="min-w-0 flex-1 truncate text-sm" title={title}>
                                                            {title}
                                                        </span>
                                                        <ui.Button
                                                            variant="ghost"
                                                            size="icon-sm"
                                                            aria-label={t("catalogue.what", { title })}
                                                            title={t("catalogue.what", { title })}
                                                            aria-expanded={explained.has(template.id)}
                                                            onClick={() => toggle(template.id)}
                                                        >
                                                            <Info className="size-4" />
                                                        </ui.Button>
                                                        <ui.Switch
                                                            checked={on && state.enabled}
                                                            disabled={locked || !state.enabled}
                                                            aria-label={title}
                                                            onChange={(enabled) =>
                                                                onChange({
                                                                    ...settings,
                                                                    disabled: enabled
                                                                        ? settings.disabled.filter((one) => one !== template.id)
                                                                        : [...settings.disabled, template.id]
                                                                })
                                                            }
                                                        />
                                                    </div>
                                                    {explained.has(template.id) && (
                                                        <ChallengeExplained template={template} t={t} language={language} />
                                                    )}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </li>
                        );
                    })}
                </ul>
                <div className="flex flex-col gap-1">
                    <p className="text-sm font-medium">{t("catalogue.meta")}</p>
                    {catalog.META_RULES.map((rule) => (
                        <p key={rule.id} className="text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{t("catalogue.metaRule", { title: rule.title[language] })} </span>
                            {rule.how[language]}
                        </p>
                    ))}
                </div>
            </ui.CardBody>
        </ui.Card>
    );
}
