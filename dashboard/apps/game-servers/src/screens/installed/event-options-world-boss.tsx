"use client";

/**
 * A world boss's settings: how hard it is, which boss - one drawn each time
 * from a pool, or always the same - whether it fights in the sky arena, its
 * health and where it appears. And what the panel says about it.
 */

import type { GameKey } from "../../../messages";
import { useGameText, type GameText } from "../game-text";
import * as catalog from "../../lib/minecraft/events/catalog";
import { Input, SegmentedControl, Select, Switch } from "@polaris/ui";
import { Field, PlaceField, numberOf, options, problemAt } from "./event-editor";

type Value = catalog.EventOptions<"world-boss">;
type Issues = readonly { path: (string | number)[]; message: string }[];

export const BOSS_LABELS: Readonly<Record<catalog.BossKind, GameKey<"minecraft">>> = {
    "wither-skeleton": "editor.labels.boss.wither-skeleton",
    ravager: "editor.labels.boss.ravager",
    vindicator: "editor.labels.boss.vindicator",
    husk: "editor.labels.boss.husk",
    evoker: "editor.labels.boss.evoker",
    captain: "editor.labels.boss.captain",
    wither: "editor.labels.boss.wither"
};

const DIFFICULTY_LABELS: Readonly<Record<catalog.BossDifficulty, GameKey<"minecraft">>> = {
    normal: "editor.labels.bossDifficulty.normal",
    hard: "editor.labels.bossDifficulty.hard",
    epic: "editor.labels.bossDifficulty.epic"
};

const RANDOM = "random";

export function WorldBossOptions({
    value,
    onChange,
    issues
}: {
    value: Value;
    onChange: (next: Value) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    const usable = catalog.bossesFor(value.arena);
    const pool = value.pool.filter((kind) => usable.includes(kind));
    const picked = value.choice === "random" ? RANDOM : value.boss;
    const witherAlone = !value.arena && value.choice === "chosen" && !usable.includes(value.boss);
    const toggle = (kind: catalog.BossKind, on: boolean) => {
        const next = on ? [...value.pool, kind] : value.pool.filter((one) => one !== kind);
        // Never none: the last boss that can fight here stays in.
        if (!on && catalog.bossesFor(value.arena, next).length === 0) return;
        onChange({ ...value, pool: catalog.BOSS_KINDS.filter((one) => next.includes(one)) });
    };
    return (
        <>
            <Field label={t("editor.bossDifficulty")} hint={t("editor.bossDifficultyHint")}>
                <SegmentedControl
                    value={value.difficulty}
                    onValueChange={(difficulty) =>
                        onChange({ ...value, difficulty: difficulty as Value["difficulty"] })
                    }
                    options={options(t, DIFFICULTY_LABELS)}
                    aria-label={t("editor.bossDifficulty")}
                />
            </Field>
            <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                    <span className="font-medium">{t("editor.skyArena")}</span>
                    <span className="block text-xs text-muted-foreground">
                        {t("editor.skyArenaHint")}
                    </span>
                </span>
                <Switch
                    checked={value.arena}
                    onChange={(arena) => onChange({ ...value, arena })}
                    aria-label={t("editor.skyArena")}
                />
            </label>
            <Field
                label={t("editor.whichBoss")}
                problem={
                    witherAlone || problemAt(issues, "options", "boss")
                        ? t("editor.witherNeedsArena")
                        : null
                }
            >
                <Select
                    value={picked}
                    onValueChange={(chosen) =>
                        onChange(
                            chosen === RANDOM
                                ? { ...value, choice: "random" }
                                : { ...value, choice: "chosen", boss: chosen as catalog.BossKind }
                        )
                    }
                    options={[
                        { value: RANDOM, label: t("editor.labels.boss.random") },
                        ...catalog.BOSS_KINDS.map((kind) => ({
                            value: kind,
                            label: t(BOSS_LABELS[kind]),
                            disabled: !usable.includes(kind)
                        }))
                    ]}
                    aria-label={t("editor.whichBoss")}
                />
            </Field>
            {value.choice === "random" ? (
                <fieldset className="flex flex-col gap-2 text-sm">
                    <legend className="font-medium">{t("editor.bossPool")}</legend>
                    <span className="text-xs text-muted-foreground">{t("editor.bossPoolHint")}</span>
                    {catalog.BOSS_KINDS.map((kind) => {
                        const allowed = usable.includes(kind);
                        const on = allowed && pool.includes(kind);
                        return (
                            <label key={kind} className="flex items-center justify-between gap-3">
                                <span className={allowed ? undefined : "text-muted-foreground"}>
                                    {t(BOSS_LABELS[kind])}
                                </span>
                                <Switch
                                    checked={on}
                                    disabled={!allowed || (on && pool.length === 1)}
                                    onChange={(next) => toggle(kind, next)}
                                    aria-label={t(BOSS_LABELS[kind])}
                                />
                            </label>
                        );
                    })}
                    {problemAt(issues, "options", "pool") ? (
                        <span className="text-xs text-danger">{t("editor.bossPoolEmpty")}</span>
                    ) : null}
                </fieldset>
            ) : null}
            <Field
                label={t("editor.baseHealth")}
                hint={t("editor.baseHealthHint")}
                problem={problemAt(issues, "options", "health")}
            >
                <Input
                    type="number"
                    min={100}
                    max={1024}
                    value={Number.isFinite(value.health) ? value.health : ""}
                    onChange={(event) => onChange({ ...value, health: numberOf(event.target.value) })}
                />
            </Field>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t(value.arena ? "editor.place.arena" : "editor.place.boss")}
                issues={issues}
                path={["options", "place"]}
            />
        </>
    );
}

/** What the panel says about a world boss, besides what every event says. */
export function worldBossFacts(t: GameText<"minecraft">, value: Value): string[] {
    const names = (kinds: readonly catalog.BossKind[]) =>
        kinds.map((kind) => t(BOSS_LABELS[kind])).join(", ");
    const drawn =
        value.choice === "random"
            ? catalog.bossesFor(value.arena, value.pool)
            : catalog.bossesFor(value.arena, [value.boss]);
    const griefing = drawn.filter((kind) => catalog.holdsGriefing(kind, value.arena));
    const facts = [
        value.choice === "random"
            ? t("events.facts.bossDrawn", { bosses: names(drawn) })
            : t("events.facts.bossChosen", { boss: names(drawn) }),
        t("events.facts.bossFight", {
            difficulty: t(DIFFICULTY_LABELS[value.difficulty])
        }),
        t(value.arena ? "events.facts.bossArena" : "events.facts.bossGround"),
        t("events.facts.bossKeeps")
    ];
    if (griefing.length > 0) facts.push(t("events.facts.bossGriefing", { bosses: names(griefing) }));
    facts.push(t("events.facts.bossPrizes", { times: catalog.BOSS_PRIZE_TIMES[value.difficulty] }));
    return facts;
}
