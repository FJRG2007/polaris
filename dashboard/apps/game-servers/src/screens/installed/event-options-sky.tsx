"use client";

/**
 * The options of the newer events played on a map built in the sky: a TNT
 * run's floors, an ice track's laps, a dropper's shaft, a flag game, hide and
 * seek, a hot potato and SkyWars.
 */

import { useGameText } from "../game-text";
import { Input, Select } from "@polaris/ui";
import type { GameKey } from "../../../messages";
import * as catalog from "../../lib/minecraft/events/catalog";
import { DIFFICULTY_LABELS, Field, PlaceField, numberOf, options, problemAt } from "./event-editor";

type Issues = readonly { path: (string | number)[]; message: string }[];

const KIT_LABELS: Readonly<Record<(typeof catalog.DUEL_KITS)[number], GameKey<"minecraft">>> = {
    wood: "editor.labels.kit.wood",
    stone: "editor.labels.kit.stone",
    iron: "editor.labels.kit.iron"
};

const LOOT_LABELS: Readonly<Record<(typeof catalog.SKY_WARS_LOOT)[number], GameKey<"minecraft">>> =
    {
        normal: "editor.labels.skyWarsLoot.normal",
        rich: "editor.labels.skyWarsLoot.rich"
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
                <NumberField
                    label={t("editor.outAtHearts")}
                    hint={t("editor.outAtHint")}
                    min={1}
                    max={6}
                    value={value.downHearts}
                    onChange={(downHearts) => onChange({ ...value, downHearts })}
                    issues={issues}
                    field="downHearts"
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
                    max={60}
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
