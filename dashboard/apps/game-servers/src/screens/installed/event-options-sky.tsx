"use client";

/**
 * The options of the newer events played on a map built in the sky: a TNT
 * run's floors, an ice track's laps, a dropper's shaft, a nether maze, a flag game, hide and
 * seek, a hot potato, SkyWars, an impostor game, a glass bridge, a tug of war and
 * pillars.
 */

import { useGameText } from "../game-text";
import { Input, Select, Switch } from "@polaris/ui";
import type { GameKey } from "../../../messages";
import * as catalog from "../../lib/minecraft/events/catalog";
import { DIFFICULTY_LABELS, Field, PlaceField, numberOf, options, problemAt } from "./event-editor";

type Issues = readonly { path: (string | number)[]; message: string }[];

const KIT_LABELS: Readonly<Record<(typeof catalog.DUEL_KITS)[number], GameKey<"minecraft">>> = {
    wood: "editor.labels.kit.wood",
    stone: "editor.labels.kit.stone",
    iron: "editor.labels.kit.iron"
};

const HOUSE_LABELS: Readonly<Record<(typeof catalog.HOUSE_SIZES)[number], GameKey<"minecraft">>> = {
    auto: "editor.labels.house.auto",
    small: "editor.labels.house.small",
    medium: "editor.labels.house.medium",
    large: "editor.labels.house.large"
};

const SEEK_TIME_LABELS: Readonly<Record<"auto" | "manual", GameKey<"minecraft">>> = {
    auto: "editor.labels.seekTime.auto",
    manual: "editor.labels.seekTime.manual"
};

const GLASS_MODE_LABELS: Readonly<
    Record<(typeof catalog.GLASS_BRIDGE_MODES)[number], GameKey<"minecraft">>
> = {
    free: "editor.labels.glassMode.free",
    turns: "editor.labels.glassMode.turns"
};

const MAZE_SIZE_LABELS: Readonly<
    Record<(typeof catalog.MAZE_SIZES)[number], GameKey<"minecraft">>
> = {
    small: "editor.labels.mazeSize.small",
    medium: "editor.labels.mazeSize.medium",
    large: "editor.labels.mazeSize.large"
};

const MAZE_HAZARD_LABELS: Readonly<
    Record<(typeof catalog.MAZE_HAZARDS)[number], GameKey<"minecraft">>
> = {
    few: "editor.labels.mazeHazards.few",
    some: "editor.labels.mazeHazards.some",
    many: "editor.labels.mazeHazards.many"
};

const ACID_SIZE_LABELS: Readonly<
    Record<(typeof catalog.ACID_SIZES)[number], GameKey<"minecraft">>
> = {
    small: "editor.labels.acidSize.small",
    medium: "editor.labels.acidSize.medium",
    large: "editor.labels.acidSize.large"
};

const ACIDITY_LABELS: Readonly<Record<(typeof catalog.ACIDITIES)[number], GameKey<"minecraft">>> = {
    mild: "editor.labels.acidity.mild",
    harsh: "editor.labels.acidity.harsh"
};

const ELYTRA_OBSTACLE_LABELS: Readonly<
    Record<(typeof catalog.ELYTRA_OBSTACLES)[number], GameKey<"minecraft">>
> = {
    none: "editor.labels.elytraObstacles.none",
    few: "editor.labels.elytraObstacles.few",
    many: "editor.labels.elytraObstacles.many"
};

const LOOT_LABELS: Readonly<Record<(typeof catalog.SKY_WARS_LOOT)[number], GameKey<"minecraft">>> =
    {
        normal: "editor.labels.skyWarsLoot.normal",
        rich: "editor.labels.skyWarsLoot.rich"
    };

const POOL_LABELS: Readonly<Record<(typeof catalog.PILLAR_POOLS)[number], GameKey<"minecraft">>> = {
    balanced: "editor.labels.pillarPool.balanced",
    blocks: "editor.labels.pillarPool.blocks",
    chaos: "editor.labels.pillarPool.chaos"
};

/** A whole number from `min` to `max`, with the schema's complaint about it. */
export function NumberField({
    label,
    hint,
    min,
    max,
    value,
    onChange,
    issues,
    field
}: {
    label: string;
    hint: string;
    min: number;
    max: number;
    value: number;
    onChange: (value: number) => void;
    issues: Issues;
    field: string;
}) {
    return (
        <Field label={label} hint={hint} problem={problemAt(issues, "options", field)}>
            <Input
                type="number"
                min={min}
                max={max}
                value={Number.isFinite(value) ? value : ""}
                onChange={(event) => onChange(numberOf(event.target.value))}
            />
        </Field>
    );
}

function HeightField({
    value,
    onChange,
    issues
}: {
    value: number;
    onChange: (value: number) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <NumberField
            label={t("editor.heightBlocks")}
            hint={t("editor.25To40AboveThe")}
            min={25}
            max={40}
            value={value}
            onChange={onChange}
            issues={issues}
            field="height"
        />
    );
}

export function TntRunFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"tnt-run">;
    onChange: (options: catalog.EventOptions<"tnt-run">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.openGround")}
                issues={issues}
                path={["options", "place"]}
            />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <NumberField
                    label={t("editor.floorSizeBlocksFromThe")}
                    hint={
                        Number.isFinite(value.size)
                            ? t("editor.floorSizeHint", { size: value.size * 2 + 1 })
                            : t("editor.5To15")
                    }
                    min={5}
                    max={15}
                    value={value.size}
                    onChange={(size) => onChange({ ...value, size })}
                    issues={issues}
                    field="size"
                />
                <NumberField
                    label={t("editor.floors")}
                    hint={t("editor.floorsHint")}
                    min={2}
                    max={4}
                    value={value.layers}
                    onChange={(layers) => onChange({ ...value, layers })}
                    issues={issues}
                    field="layers"
                />
                <HeightField
                    value={value.height}
                    onChange={(height) => onChange({ ...value, height })}
                    issues={issues}
                />
            </div>
        </>
    );
}

export function BoatRaceFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"boat-race">;
    onChange: (options: catalog.EventOptions<"boat-race">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.track")}
                issues={issues}
                path={["options", "place"]}
            />
            <div className="grid grid-cols-2 gap-3">
                <NumberField
                    label={t("editor.laps")}
                    hint={t("editor.lapsHint")}
                    min={1}
                    max={5}
                    value={value.laps}
                    onChange={(laps) => onChange({ ...value, laps })}
                    issues={issues}
                    field="laps"
                />
                <HeightField
                    value={value.height}
                    onChange={(height) => onChange({ ...value, height })}
                    issues={issues}
                />
            </div>
        </>
    );
}

const DOWNHILL_STEEPNESS_LABELS: Readonly<
    Record<(typeof catalog.DOWNHILL_STEEPNESS)[number], GameKey<"minecraft">>
> = {
    gentle: "editor.labels.downhillSteepness.gentle",
    steep: "editor.labels.downhillSteepness.steep"
};

export function DownhillRaceFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"downhill-race">;
    onChange: (options: catalog.EventOptions<"downhill-race">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.downhill")}
                issues={issues}
                path={["options", "place"]}
            />
            <div className="grid grid-cols-2 gap-3">
                <Field
                    label={t("editor.downhillSteepness")}
                    hint={t("editor.downhillSteepnessHint")}
                >
                    <Select
                        value={value.steepness}
                        onValueChange={(steepness) =>
                            onChange({ ...value, steepness: steepness as typeof value.steepness })
                        }
                        options={options(t, DOWNHILL_STEEPNESS_LABELS)}
                        aria-label={t("editor.downhillSteepness")}
                    />
                </Field>
                <HeightField
                    value={value.height}
                    onChange={(height) => onChange({ ...value, height })}
                    issues={issues}
                />
            </div>
        </>
    );
}

export function DropperFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"dropper">;
    onChange: (options: catalog.EventOptions<"dropper">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.shaft")}
                issues={issues}
                path={["options", "place"]}
            />
            <div className="grid grid-cols-2 gap-3">
                <NumberField
                    label={t("editor.dropFloors")}
                    hint={t("editor.dropFloorsHint")}
                    min={5}
                    max={20}
                    value={value.levels}
                    onChange={(levels) => onChange({ ...value, levels })}
                    issues={issues}
                    field="levels"
                />
                <Field label={t("editor.difficulty")}>
                    <Select
                        value={value.difficulty}
                        onValueChange={(difficulty) =>
                            onChange({
                                ...value,
                                difficulty: difficulty as typeof value.difficulty
                            })
                        }
                        options={options(t, DIFFICULTY_LABELS)}
                        aria-label={t("editor.difficulty")}
                    />
                </Field>
            </div>
        </>
    );
}

export function NetherMazeFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"nether-maze">;
    onChange: (options: catalog.EventOptions<"nether-maze">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.maze")}
                issues={issues}
                path={["options", "place"]}
            />
            <div className="grid grid-cols-2 gap-3">
                <Field label={t("editor.mazeSize")}>
                    <Select
                        value={value.size}
                        onValueChange={(size) =>
                            onChange({ ...value, size: size as typeof value.size })
                        }
                        options={options(t, MAZE_SIZE_LABELS)}
                        aria-label={t("editor.mazeSize")}
                    />
                </Field>
                <Field label={t("editor.mazeHazards")} hint={t("editor.mazeHazardsHint")}>
                    <Select
                        value={value.hazards}
                        onValueChange={(hazards) =>
                            onChange({ ...value, hazards: hazards as typeof value.hazards })
                        }
                        options={options(t, MAZE_HAZARD_LABELS)}
                        aria-label={t("editor.mazeHazards")}
                    />
                </Field>
                <HeightField
                    value={value.height}
                    onChange={(height) => onChange({ ...value, height })}
                    issues={issues}
                />
            </div>
        </>
    );
}

export function AcidRainFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"acid-rain">;
    onChange: (options: catalog.EventOptions<"acid-rain">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.acid")}
                issues={issues}
                path={["options", "place"]}
            />
            <div className="grid grid-cols-2 gap-3">
                <Field label={t("editor.acidSize")}>
                    <Select
                        value={value.size}
                        onValueChange={(size) =>
                            onChange({ ...value, size: size as typeof value.size })
                        }
                        options={options(t, ACID_SIZE_LABELS)}
                        aria-label={t("editor.acidSize")}
                    />
                </Field>
                <Field label={t("editor.acidity")} hint={t("editor.acidityHint")}>
                    <Select
                        value={value.acidity}
                        onValueChange={(acidity) =>
                            onChange({ ...value, acidity: acidity as typeof value.acidity })
                        }
                        options={options(t, ACIDITY_LABELS)}
                        aria-label={t("editor.acidity")}
                    />
                </Field>
                <HeightField
                    value={value.height}
                    onChange={(height) => onChange({ ...value, height })}
                    issues={issues}
                />
            </div>
        </>
    );
}

export function ElytraRaceFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"elytra-race">;
    onChange: (options: catalog.EventOptions<"elytra-race">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.elytra")}
                issues={issues}
                path={["options", "place"]}
            />
            <div className="grid grid-cols-2 gap-3">
                <NumberField
                    label={t("editor.elytraLaps")}
                    hint={t("editor.range", { min: 1, max: 3 })}
                    min={1}
                    max={3}
                    value={value.laps}
                    onChange={(laps) => onChange({ ...value, laps })}
                    issues={issues}
                    field="laps"
                />
                <Field label={t("editor.elytraObstacles")} hint={t("editor.elytraObstaclesHint")}>
                    <Select
                        value={value.obstacles}
                        onValueChange={(obstacles) =>
                            onChange({ ...value, obstacles: obstacles as typeof value.obstacles })
                        }
                        options={options(t, ELYTRA_OBSTACLE_LABELS)}
                        aria-label={t("editor.elytraObstacles")}
                    />
                </Field>
                <NumberField
                    label={t("editor.heightBlocks")}
                    hint={t("editor.range", { min: 40, max: 80 })}
                    min={40}
                    max={80}
                    value={value.height}
                    onChange={(height) => onChange({ ...value, height })}
                    issues={issues}
                    field="height"
                />
            </div>
        </>
    );
}

export function CaptureTheFlagFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"capture-the-flag">;
    onChange: (options: catalog.EventOptions<"capture-the-flag">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <Field label={t("editor.kit")} hint={t("editor.kitHint")}>
                <Select
                    value={value.kit}
                    onValueChange={(kit) => onChange({ ...value, kit: kit as typeof value.kit })}
                    options={options(t, KIT_LABELS)}
                    aria-label={t("editor.kit")}
                />
            </Field>
            <div className="grid grid-cols-2 gap-3">
                <NumberField
                    label={t("editor.capturesToWin")}
                    hint={t("editor.capturesToWinHint")}
                    min={1}
                    max={10}
                    value={value.captures}
                    onChange={(captures) => onChange({ ...value, captures })}
                    issues={issues}
                    field="captures"
                />
            </div>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.arena")}
                issues={issues}
                path={["options", "place"]}
            />
        </>
    );
}

export function HideAndSeekFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"hide-and-seek">;
    onChange: (options: catalog.EventOptions<"hide-and-seek">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <div className="grid grid-cols-2 gap-3">
                <NumberField
                    label={t("editor.hideSeconds")}
                    hint={t("editor.hideSecondsHint")}
                    min={15}
                    max={catalog.MOST_HIDE_SECONDS}
                    value={value.hideSeconds}
                    onChange={(hideSeconds) => onChange({ ...value, hideSeconds })}
                    issues={issues}
                    field="hideSeconds"
                />
                <NumberField
                    label={t("editor.seekers")}
                    hint={t("editor.seekersHint")}
                    min={1}
                    max={3}
                    value={value.seekers}
                    onChange={(seekers) => onChange({ ...value, seekers })}
                    issues={issues}
                    field="seekers"
                />
                <Field label={t("editor.house")}>
                    <Select
                        value={value.house}
                        onValueChange={(house) =>
                            onChange({ ...value, house: house as typeof value.house })
                        }
                        options={options(t, HOUSE_LABELS)}
                        aria-label={t("editor.house")}
                    />
                </Field>
                <Field label={t("editor.seekTime")} hint={t("editor.seekTimeHint")}>
                    <Select
                        value={value.seekMinutes === "auto" ? "auto" : "manual"}
                        onValueChange={(mode) =>
                            onChange({
                                ...value,
                                seekMinutes:
                                    mode === "auto"
                                        ? "auto"
                                        : catalog.SEEK_MINUTES_BY_ROOMS[
                                              catalog.houseRooms(0, value.house)
                                          ]!
                            })
                        }
                        options={options(t, SEEK_TIME_LABELS)}
                        aria-label={t("editor.seekTime")}
                    />
                </Field>
                {value.seekMinutes !== "auto" && (
                    <NumberField
                        label={t("editor.seekMinutes")}
                        hint={t("editor.range", {
                            min: catalog.SEEK_MINUTES.min,
                            max: catalog.SEEK_MINUTES.max
                        })}
                        min={catalog.SEEK_MINUTES.min}
                        max={catalog.SEEK_MINUTES.max}
                        value={value.seekMinutes}
                        onChange={(seekMinutes) => onChange({ ...value, seekMinutes })}
                        issues={issues}
                        field="seekMinutes"
                    />
                )}
                <NumberField
                    label={t("editor.revealSeconds")}
                    hint={t("editor.revealSecondsHint", { max: catalog.MOST_REVEAL_SECONDS })}
                    min={0}
                    max={catalog.MOST_REVEAL_SECONDS}
                    value={value.revealSeconds}
                    onChange={(revealSeconds) => onChange({ ...value, revealSeconds })}
                    issues={issues}
                    field="revealSeconds"
                />
                <NumberField
                    label={t("editor.freezePotions")}
                    hint={t("editor.freezePotionsHint", { max: catalog.MOST_FREEZE_POTIONS })}
                    min={0}
                    max={catalog.MOST_FREEZE_POTIONS}
                    value={value.freezePotions}
                    onChange={(freezePotions) => onChange({ ...value, freezePotions })}
                    issues={issues}
                    field="freezePotions"
                />
                {value.freezePotions > 0 && (
                    <NumberField
                        label={t("editor.freezeSeconds")}
                        hint={t("editor.range", {
                            min: catalog.FREEZE_SECONDS_RANGE.min,
                            max: catalog.FREEZE_SECONDS_RANGE.max
                        })}
                        min={catalog.FREEZE_SECONDS_RANGE.min}
                        max={catalog.FREEZE_SECONDS_RANGE.max}
                        value={value.freezeSeconds}
                        onChange={(freezeSeconds) => onChange({ ...value, freezeSeconds })}
                        issues={issues}
                        field="freezeSeconds"
                    />
                )}
                <NumberField
                    label={t("editor.powerUpMinutes")}
                    hint={t("editor.powerUpMinutesHint")}
                    min={0}
                    max={10}
                    value={value.powerUpMinutes}
                    onChange={(powerUpMinutes) => onChange({ ...value, powerUpMinutes })}
                    issues={issues}
                    field="powerUpMinutes"
                />
            </div>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.arena")}
                issues={issues}
                path={["options", "place"]}
            />
        </>
    );
}

export function HotPotatoFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"hot-potato">;
    onChange: (options: catalog.EventOptions<"hot-potato">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <NumberField
                label={t("editor.fuseSeconds")}
                hint={t("editor.fuseSecondsHint")}
                min={10}
                max={40}
                value={value.fuseSeconds}
                onChange={(fuseSeconds) => onChange({ ...value, fuseSeconds })}
                issues={issues}
                field="fuseSeconds"
            />
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.arena")}
                issues={issues}
                path={["options", "place"]}
            />
        </>
    );
}

export function TugOfWarFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"tug-of-war">;
    onChange: (options: catalog.EventOptions<"tug-of-war">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <NumberField
                label={t("editor.ropeLength")}
                hint={t("editor.ropeLengthHint")}
                min={6}
                max={16}
                value={value.ropeLength}
                onChange={(ropeLength) => onChange({ ...value, ropeLength })}
                issues={issues}
                field="ropeLength"
            />
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.arena")}
                issues={issues}
                path={["options", "place"]}
            />
        </>
    );
}

export function ImpostorFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"impostor">;
    onChange: (options: catalog.EventOptions<"impostor">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <div className="grid grid-cols-2 gap-3">
                <NumberField
                    label={t("editor.impostorCount")}
                    hint={t("editor.impostorCountHint")}
                    min={1}
                    max={3}
                    value={value.impostors}
                    onChange={(impostors) => onChange({ ...value, impostors })}
                    issues={issues}
                    field="impostors"
                />
                <NumberField
                    label={t("editor.killCooldown")}
                    hint={t("editor.killCooldownHint")}
                    min={10}
                    max={60}
                    value={value.killCooldown}
                    onChange={(killCooldown) => onChange({ ...value, killCooldown })}
                    issues={issues}
                    field="killCooldown"
                />
                <NumberField
                    label={t("editor.impostorTasks")}
                    hint={t("editor.impostorTasksHint")}
                    min={1}
                    max={8}
                    value={value.tasks}
                    onChange={(tasks) => onChange({ ...value, tasks })}
                    issues={issues}
                    field="tasks"
                />
                <NumberField
                    label={t("editor.emergencies")}
                    hint={t("editor.emergenciesHint")}
                    min={0}
                    max={3}
                    value={value.emergencies}
                    onChange={(emergencies) => onChange({ ...value, emergencies })}
                    issues={issues}
                    field="emergencies"
                />
                <NumberField
                    label={t("editor.discussionSeconds")}
                    hint={t("editor.discussionSecondsHint")}
                    min={0}
                    max={120}
                    value={value.discussionSeconds}
                    onChange={(discussionSeconds) => onChange({ ...value, discussionSeconds })}
                    issues={issues}
                    field="discussionSeconds"
                />
                <NumberField
                    label={t("editor.votingSeconds")}
                    hint={t("editor.votingSecondsHint")}
                    min={15}
                    max={120}
                    value={value.votingSeconds}
                    onChange={(votingSeconds) => onChange({ ...value, votingSeconds })}
                    issues={issues}
                    field="votingSeconds"
                />
            </div>
            <label className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 font-medium">{t("editor.confirmEjects")}</span>
                <Switch
                    checked={value.confirmEjects}
                    onChange={(confirmEjects) => onChange({ ...value, confirmEjects })}
                    aria-label={t("editor.confirmEjects")}
                />
            </label>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.arena")}
                issues={issues}
                path={["options", "place"]}
            />
        </>
    );
}

export function SkyWarsFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"sky-wars">;
    onChange: (options: catalog.EventOptions<"sky-wars">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <div className="grid grid-cols-2 gap-3">
                <Field label={t("editor.chestLoot")}>
                    <Select
                        value={value.loot}
                        onValueChange={(loot) =>
                            onChange({ ...value, loot: loot as typeof value.loot })
                        }
                        options={options(t, LOOT_LABELS)}
                        aria-label={t("editor.chestLoot")}
                    />
                </Field>
                <HeightField
                    value={value.height}
                    onChange={(height) => onChange({ ...value, height })}
                    issues={issues}
                />
            </div>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.islands")}
                issues={issues}
                path={["options", "place"]}
            />
        </>
    );
}

export function GlassBridgeFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"glass-bridge">;
    onChange: (options: catalog.EventOptions<"glass-bridge">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <div className="grid grid-cols-2 gap-3">
                <Field label={t("editor.glassMode")}>
                    <Select
                        value={value.mode}
                        onValueChange={(mode) =>
                            onChange({ ...value, mode: mode as typeof value.mode })
                        }
                        options={options(t, GLASS_MODE_LABELS)}
                        aria-label={t("editor.glassMode")}
                    />
                </Field>
                <NumberField
                    label={t("editor.glassSteps")}
                    hint={t("editor.glassStepsHint")}
                    min={6}
                    max={20}
                    value={value.steps}
                    onChange={(steps) => onChange({ ...value, steps })}
                    issues={issues}
                    field="steps"
                />
                {value.mode === "turns" && (
                    <NumberField
                        label={t("editor.turnSeconds")}
                        hint={t("editor.turnSecondsHint")}
                        min={10}
                        max={60}
                        value={value.turnSeconds}
                        onChange={(turnSeconds) => onChange({ ...value, turnSeconds })}
                        issues={issues}
                        field="turnSeconds"
                    />
                )}
            </div>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.arena")}
                issues={issues}
                path={["options", "place"]}
            />
        </>
    );
}

export function PillarsFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"pillars">;
    onChange: (options: catalog.EventOptions<"pillars">) => void;
    issues: Issues;
}) {
    const t = useGameText("minecraft");
    return (
        <>
            <div className="grid grid-cols-2 gap-3">
                <Field label={t("editor.itemPool")}>
                    <Select
                        value={value.pool}
                        onValueChange={(pool) =>
                            onChange({ ...value, pool: pool as typeof value.pool })
                        }
                        options={options(t, POOL_LABELS)}
                        aria-label={t("editor.itemPool")}
                    />
                </Field>
                <NumberField
                    label={t("editor.itemInterval")}
                    hint={t("editor.itemIntervalHint")}
                    min={3}
                    max={20}
                    value={value.interval}
                    onChange={(interval) => onChange({ ...value, interval })}
                    issues={issues}
                    field="interval"
                />
                <NumberField
                    label={t("editor.pillarHeight")}
                    hint={t("editor.pillarHeightHint")}
                    min={40}
                    max={60}
                    value={value.height}
                    onChange={(height) => onChange({ ...value, height })}
                    issues={issues}
                    field="height"
                />
                <NumberField
                    label={t("editor.voidAfter")}
                    hint={t("editor.voidAfterHint")}
                    min={0}
                    max={15}
                    value={value.voidAfter}
                    onChange={(voidAfter) => onChange({ ...value, voidAfter })}
                    issues={issues}
                    field="voidAfter"
                />
            </div>
            <label className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 font-medium">{t("editor.pillarMiddle")}</span>
                <Switch
                    checked={value.middle}
                    onChange={(middle) => onChange({ ...value, middle })}
                    aria-label={t("editor.pillarMiddle")}
                />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 font-medium">{t("editor.pillarTwists")}</span>
                <Switch
                    checked={value.twists}
                    onChange={(twists) => onChange({ ...value, twists })}
                    aria-label={t("editor.pillarTwists")}
                />
            </label>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.pillars")}
                issues={issues}
                path={["options", "place"]}
            />
        </>
    );
}
