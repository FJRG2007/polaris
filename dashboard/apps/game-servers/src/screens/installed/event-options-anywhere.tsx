"use client";

/**
 * The options of a villager defense, a bingo rush and a boss fishing: played
 * on the world's own ground or wherever the players are.
 */

import { useGameText } from "../game-text";
import type { GameKey } from "../../../messages";
import { NumberField } from "./event-options-sky";
import { SegmentedControl, Select } from "@polaris/ui";
import * as catalog from "../../lib/minecraft/events/catalog";
import { DIFFICULTY_LABELS, Field, PlaceField, options } from "./event-editor";

type Issues = readonly { path: (string | number)[]; message: string }[];

/** A villager defense's mixes: only monsters that go for a villager
 *  (`kinds/village-defense.VILLAGE_MOBS`), so not the horde defense's words. */
const VILLAGE_MIX_LABELS: Readonly<
    Record<(typeof catalog.WAVE_MIXES)[number], GameKey<"minecraft">>
> = {
    classic: "editor.labels.villageMix.classic",
    undead: "editor.labels.villageMix.undead",
    mixed: "editor.labels.villageMix.mixed"
};

const GOAL_LABELS: Readonly<Record<(typeof catalog.BINGO_GOALS)[number], GameKey<"minecraft">>> = {
    line: "editor.labels.bingoGoal.line",
    card: "editor.labels.bingoGoal.card"
};

export function VillageDefenseFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"village-defense">;
    onChange: (options: catalog.EventOptions<"village-defense">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.villager")}
                issues={issues}
                path={["options", "place"]}
            />
            <div className="grid grid-cols-2 gap-3">
                <NumberField
                    label={t("editor.waves")}
                    hint={t("editor.3To10")}
                    min={3}
                    max={10}
                    value={value.waves}
                    onChange={(waves) => onChange({ ...value, waves })}
                    issues={issues}
                    field="waves"
                />
                <NumberField
                    label={t("editor.firstWaveSize")}
                    hint={t("editor.2To12ForOne")}
                    min={2}
                    max={12}
                    value={value.size}
                    onChange={(size) => onChange({ ...value, size })}
                    issues={issues}
                    field="size"
                />
            </div>
            <Field label={t("editor.monsters")} hint={t("editor.onlyVillagerHunters")}>
                <Select
                    value={value.mix}
                    onValueChange={(mix) => onChange({ ...value, mix: mix as typeof value.mix })}
                    options={options(t, VILLAGE_MIX_LABELS)}
                    aria-label={t("editor.monsters")}
                />
            </Field>
        </>
    );
}

export function BingoFields({
    value,
    onChange
}: {
    value: catalog.EventOptions<"bingo">;
    onChange: (options: catalog.EventOptions<"bingo">) => void;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <Field label={t("editor.bingoGoal")}>
                <SegmentedControl
                    value={value.goal}
                    onValueChange={(goal) =>
                        onChange({ ...value, goal: goal as typeof value.goal })
                    }
                    options={options(t, GOAL_LABELS)}
                    aria-label={t("editor.bingoGoal")}
                />
            </Field>
            <Field label={t("editor.bingoItems")} hint={t("editor.bingoItemsHint")}>
                <Select
                    value={value.difficulty}
                    onValueChange={(difficulty) =>
                        onChange({ ...value, difficulty: difficulty as typeof value.difficulty })
                    }
                    options={options(t, DIFFICULTY_LABELS)}
                    aria-label={t("editor.bingoItems")}
                />
            </Field>
        </>
    );
}

export function BossFishingFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"boss-fishing">;
    onChange: (options: catalog.EventOptions<"boss-fishing">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <NumberField
            label={t("editor.fishCatches")}
            hint={t("editor.fishCatchesHint")}
            min={3}
            max={30}
            value={value.catches}
            onChange={(catches) => onChange({ ...value, catches })}
            issues={issues}
            field="catches"
        />
    );
}
