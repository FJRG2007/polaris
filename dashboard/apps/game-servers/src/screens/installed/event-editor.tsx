"use client";

/**
 * Setting up one event: its name, how long it runs, what it is played with and
 * what the podium wins.
 *
 * Checked as it is typed against the same schema the save is checked with on the
 * server, so a value the server would refuse is said beside the field it came
 * from, not after pressing Save.
 */

import { useMemo, useState } from "react";
import { useGameText, useSchemaText, type GameText } from "../game-text";
import type { GameKey } from "../../../messages";
import { incompatibleText, kindLabel, kindSummary, kindUnit } from "./event-kinds";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Select,
    Switch,
    Textarea
} from "@polaris/ui";
import * as catalog from "../../lib/minecraft/events/catalog";
import { TreasureHuntOptions } from "./event-options-treasure-hunt";
import { GatheringOptions } from "./event-options-gathering";
import { RareCatchOptions } from "./event-options-rare-catch";
import { XpBoostOptions } from "./event-options-xp-boost";
import { BuildBattleFields, TeamDuelFields } from "./event-options-arena";
import { ItemSlots } from "./item-slots";
import { WorldBossOptions } from "./event-options-world-boss";
import {
    AcidRainFields,
    BoatRaceFields,
    CaptureTheFlagFields,
    DropperFields,
    ElytraRaceFields,
    HideAndSeekFields,
    HotPotatoFields,
    NetherMazeFields,
    SkyWarsFields,
    TntRunFields
} from "./event-options-sky";
import { BingoFields, BossFishingFields, VillageDefenseFields } from "./event-options-anywhere";

const MINING_LABELS: Readonly<
    Record<(typeof catalog.MINING_TARGETS)[number], GameKey<"minecraft">>
> = {
    "any-ore": "editor.labels.mining.any-ore",
    diamond: "editor.labels.mining.diamond",
    debris: "editor.labels.mining.debris"
};

const HUNT_LABELS: Readonly<Record<(typeof catalog.HUNT_TARGETS)[number], GameKey<"minecraft">>> = {
    hostile: "editor.labels.hunt.hostile",
    zombie: "editor.labels.hunt.zombie",
    skeleton: "editor.labels.hunt.skeleton",
    creeper: "editor.labels.hunt.creeper",
    spider: "editor.labels.hunt.spider",
    enderman: "editor.labels.hunt.enderman"
};

export const LOOT_LABELS: Readonly<
    Record<(typeof catalog.LOOT_TABLES)[number], GameKey<"minecraft">>
> = {
    treasure: "editor.labels.loot.treasure",
    dungeon: "editor.labels.loot.dungeon",
    bastion: "editor.labels.loot.bastion",
    "end-city": "editor.labels.loot.end-city",
    "ancient-city": "editor.labels.loot.ancient-city"
};

const THEME_LABELS: Readonly<
    Record<"random" | (typeof catalog.PARKOUR_THEMES)[number], GameKey<"minecraft">>
> = {
    random: "editor.labels.course.random",
    classic: "editor.labels.course.classic",
    frost: "editor.labels.course.frost",
    jungle: "editor.labels.course.jungle",
    nether: "editor.labels.course.nether"
};

const SHAPE_LABELS: Readonly<
    Record<(typeof catalog.PARKOUR_SHAPES)[number], GameKey<"minecraft">>
> = {
    rows: "editor.labels.parkourShape.rows",
    tower: "editor.labels.parkourShape.tower",
    line: "editor.labels.parkourShape.line",
    snake: "editor.labels.parkourShape.snake",
    spiral: "editor.labels.parkourShape.spiral"
};

const SPLEEF_LABELS: Readonly<
    Record<(typeof catalog.SPLEEF_VARIANTS)[number], GameKey<"minecraft">>
> = {
    shovel: "editor.labels.spleef.shovel",
    decay: "editor.labels.spleef.decay",
    snowballs: "editor.labels.spleef.snowballs"
};

const INTENSITY_LABELS: Readonly<
    Record<(typeof catalog.INTENSITIES)[number], GameKey<"minecraft">>
> = {
    low: "editor.labels.intensity.low",
    medium: "editor.labels.intensity.medium",
    high: "editor.labels.intensity.high"
};

export const WAVE_MIX_LABELS: Readonly<
    Record<(typeof catalog.WAVE_MIXES)[number], GameKey<"minecraft">>
> = {
    classic: "editor.labels.waveMix.classic",
    undead: "editor.labels.waveMix.undead",
    mixed: "editor.labels.waveMix.mixed"
};

const WAVE_WINNER_LABELS: Readonly<
    Record<(typeof catalog.WAVE_WINNERS)[number], GameKey<"minecraft">>
> = {
    kills: "editor.labels.wavesWinner.kills",
    damage: "editor.labels.wavesWinner.damage"
};

const METEOR_ORE_LABELS: Readonly<
    Record<(typeof catalog.METEOR_ORES)[number], GameKey<"minecraft">>
> = {
    common: "editor.labels.meteorOre.common",
    precious: "editor.labels.meteorOre.precious",
    diamond: "editor.labels.meteorOre.diamond",
    debris: "editor.labels.meteorOre.debris"
};

const TRIVIA_LABELS: Readonly<Record<(typeof catalog.TRIVIA_MODES)[number], GameKey<"minecraft">>> =
    {
        questions: "editor.labels.trivia.questions",
        scramble: "editor.labels.trivia.scramble",
        mixed: "editor.labels.trivia.mixed"
    };

export const DIFFICULTY_LABELS: Readonly<
    Record<(typeof catalog.PARKOUR_DIFFICULTIES)[number], GameKey<"minecraft">>
> = {
    easy: "editor.labels.difficulty.easy",
    medium: "editor.labels.difficulty.medium",
    hard: "editor.labels.difficulty.hard"
};

export function options<T extends string>(
    t: GameText<"minecraft">,
    labels: Readonly<Record<T, GameKey<"minecraft">>>
): { value: T; label: string }[] {
    return (Object.keys(labels) as T[]).map((value) => ({ value, label: t(labels[value]) }));
}

/** A number typed into a field, or NaN - which the schema then names. */
export function numberOf(text: string): number {
    return text.trim() === "" ? Number.NaN : Number(text);
}

/** The first problem the schema has with a path, if any. */
export function problemAt(
    issues: readonly { path: (string | number)[]; message: string }[],
    ...path: (string | number)[]
): string | null {
    const found = issues.find((issue) => path.every((part, index) => issue.path[index] === part));
    return found?.message ?? null;
}

/** A schema's complaint, in the reader's language: the schemas carry keys. */
export function Problem({
    text,
    className = ""
}: {
    text: string | null | undefined;
    className?: string;
}) {
    const schemaText = useSchemaText();
    if (!text) return null;
    return <span className={`text-xs text-danger ${className}`.trim()}>{schemaText(text)}</span>;
}

export function Field({
    label,
    hint,
    problem,
    children
}: {
    label: string;
    hint?: string;
    problem?: string | null;
    children: React.ReactNode;
}) {
    return (
        <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{label}</span>
            {children}
            {problem ? (
                <Problem text={problem} />
            ) : hint ? (
                <span className="text-xs text-muted-foreground">{hint}</span>
            ) : null}
        </label>
    );
}

/** Where an event happens: around the players, or at a point the operator set. */
export function PlaceField({
    value,
    onChange,
    what,
    issues,
    path
}: {
    value: catalog.EventPlace;
    onChange: (next: catalog.EventPlace) => void;
    what: string;
    issues: readonly { path: (string | number)[]; message: string }[];
    path: (string | number)[];
}) {
    const t = useGameText("minecraft");
    return (
        <div className="flex flex-col gap-2 text-sm">
            <span className="font-medium">{t("editor.where")}</span>
            <SegmentedControl
                value={value.mode}
                onValueChange={(mode) =>
                    onChange(mode === "fixed" ? { mode: "fixed", x: 0, z: 0 } : { mode: "players" })
                }
                options={[
                    { value: "players", label: t("editor.nearThePlayers") },
                    { value: "fixed", label: t("editor.atSetCoordinates") }
                ]}
                aria-label={t("editor.whereItHappens")}
            />
            {value.mode === "fixed" ? (
                <div className="grid grid-cols-2 gap-2">
                    <Field label={t("editor.x")} problem={problemAt(issues, ...path, "x")}>
                        <Input
                            type="number"
                            value={Number.isFinite(value.x) ? value.x : ""}
                            onChange={(event) =>
                                onChange({ ...value, x: numberOf(event.target.value) })
                            }
                        />
                    </Field>
                    <Field label={t("editor.z")} problem={problemAt(issues, ...path, "z")}>
                        <Input
                            type="number"
                            value={Number.isFinite(value.z) ? value.z : ""}
                            onChange={(event) =>
                                onChange({ ...value, z: numberOf(event.target.value) })
                            }
                        />
                    </Field>
                </div>
            ) : (
                <span className="text-xs text-muted-foreground">{what}</span>
            )}
        </div>
    );
}

function RewardEditor({
    label,
    hint,
    value,
    onChange,
    issues,
    path
}: {
    label: string;
    hint: string;
    value: catalog.Reward;
    onChange: (next: catalog.Reward) => void;
    issues: readonly { path: (string | number)[]; message: string }[];
    path: (string | number)[];
}) {
    const t = useGameText("minecraft");
    const schemaText = useSchemaText();
    return (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
            <ItemSlots
                label={label}
                items={value.items}
                onChange={(items) => onChange({ ...value, items })}
                problemAt={(index) => {
                    const problem = problemAt(issues, ...path, "items", index);
                    return problem ? schemaText(problem) : null;
                }}
            />
            <div className="flex flex-wrap items-center gap-2">
                <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    {t("editor.levels")}
                    <Input
                        className="w-20"
                        type="number"
                        min={0}
                        max={100}
                        value={Number.isFinite(value.levels) ? value.levels : ""}
                        onChange={(event) =>
                            onChange({ ...value, levels: numberOf(event.target.value) })
                        }
                    />
                </label>
            </div>
            <Problem text={problemAt(issues, ...path, "levels")} />
        </div>
    );
}

/** `Question | answer; another answer`, one a line, as the operator writes them. */
export function readQuestions(text: string): catalog.TriviaQuestion[] {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [question = "", answers = ""] = line.split("|");
            return {
                question: question.trim(),
                answers: answers
                    .split(";")
                    .map((answer) => answer.trim())
                    .filter(Boolean)
            };
        });
}

export function writeQuestions(questions: readonly catalog.TriviaQuestion[]): string {
    return questions.map((one) => `${one.question} | ${one.answers.join("; ")}`).join("\n");
}

function OptionsFields({
    preset,
    onChange,
    issues
}: {
    preset: catalog.EventPreset;
    onChange: (options: catalog.EventPreset["options"]) => void;
    issues: readonly { path: (string | number)[]; message: string }[];
}) {
    const t = useGameText("minecraft");
    const [questionsText, setQuestionsText] = useState(() =>
        preset.kind === "trivia"
            ? writeQuestions((preset.options as catalog.EventOptions<"trivia">).questions)
            : ""
    );
    switch (preset.kind) {
        case "mining-rush": {
            const value = preset.options as catalog.EventOptions<"mining-rush">;
            return (
                <Field label={t("editor.whatCounts")}>
                    <Select
                        value={value.target}
                        onValueChange={(target) =>
                            onChange({ ...value, target: target as typeof value.target })
                        }
                        options={options(t, MINING_LABELS)}
                        aria-label={t("editor.whatCounts")}
                    />
                </Field>
            );
        }
        case "mob-hunt": {
            const value = preset.options as catalog.EventOptions<"mob-hunt">;
            return (
                <Field label={t("editor.whatCounts")}>
                    <Select
                        value={value.target}
                        onValueChange={(target) =>
                            onChange({ ...value, target: target as typeof value.target })
                        }
                        options={options(t, HUNT_LABELS)}
                        aria-label={t("editor.whatCounts")}
                    />
                </Field>
            );
        }
        case "supply-drop": {
            const value = preset.options as catalog.EventOptions<"supply-drop">;
            return (
                <>
                    <PlaceField
                        value={value.place}
                        onChange={(place) => onChange({ ...value, place })}
                        what={t("editor.place.drop")}
                        issues={issues}
                        path={["options", "place"]}
                    />
                    <Field
                        label={t("editor.howFarBlocks")}
                        hint={t("editor.between100And3000Around")}
                        problem={problemAt(issues, "options", "distance")}
                    >
                        <Input
                            type="number"
                            min={100}
                            max={3000}
                            value={Number.isFinite(value.distance) ? value.distance : ""}
                            onChange={(event) =>
                                onChange({ ...value, distance: numberOf(event.target.value) })
                            }
                        />
                    </Field>
                    <Field label={t("editor.whatIsInside")}>
                        <Select
                            value={value.loot}
                            onValueChange={(loot) =>
                                onChange({ ...value, loot: loot as typeof value.loot })
                            }
                            options={options(t, LOOT_LABELS)}
                            aria-label={t("editor.whatIsInside")}
                        />
                    </Field>
                </>
            );
        }
        case "blood-moon": {
            const value = preset.options as catalog.EventOptions<"blood-moon">;
            return (
                <>
                    <Field label={t("editor.howHard")} hint={t("editor.howManyMobsRiseAround")}>
                        <SegmentedControl
                            value={value.intensity}
                            onValueChange={(intensity) =>
                                onChange({
                                    ...value,
                                    intensity: intensity as typeof value.intensity
                                })
                            }
                            options={options(t, INTENSITY_LABELS)}
                            aria-label={t("editor.howHard")}
                        />
                    </Field>
                    <label className="flex items-center justify-between gap-3 text-sm">
                        <span>
                            <span className="font-medium">{t("editor.creepersToo")}</span>
                            <span className="block text-xs text-muted-foreground">
                                {t("editor.theyBlowHolesInWhatever")}
                            </span>
                        </span>
                        <Switch
                            checked={value.creepers}
                            onChange={(creepers) => onChange({ ...value, creepers })}
                            aria-label={t("editor.creepersToo")}
                        />
                    </label>
                </>
            );
        }
        case "world-boss":
            return (
                <WorldBossOptions
                    value={preset.options as catalog.EventOptions<"world-boss">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "trivia": {
            const value = preset.options as catalog.EventOptions<"trivia">;
            return (
                <>
                    <div className="grid grid-cols-2 gap-3">
                        <Field
                            label={t("editor.rounds")}
                            problem={problemAt(issues, "options", "rounds")}
                            hint={t("editor.3To15")}
                        >
                            <Input
                                type="number"
                                min={3}
                                max={15}
                                value={Number.isFinite(value.rounds) ? value.rounds : ""}
                                onChange={(event) =>
                                    onChange({ ...value, rounds: numberOf(event.target.value) })
                                }
                            />
                        </Field>
                        <Field
                            label={t("editor.secondsARound")}
                            problem={problemAt(issues, "options", "seconds")}
                            hint={t("editor.15To90")}
                        >
                            <Input
                                type="number"
                                min={15}
                                max={90}
                                value={Number.isFinite(value.seconds) ? value.seconds : ""}
                                onChange={(event) =>
                                    onChange({ ...value, seconds: numberOf(event.target.value) })
                                }
                            />
                        </Field>
                    </div>
                    <Field label={t("editor.roundsOf")}>
                        <SegmentedControl
                            value={value.mode}
                            onValueChange={(mode) =>
                                onChange({ ...value, mode: mode as typeof value.mode })
                            }
                            options={options(t, TRIVIA_LABELS)}
                            aria-label={t("editor.roundsOf")}
                        />
                    </Field>
                    <Field
                        label={t("editor.yourOwnQuestions")}
                        hint={t("editor.oneALineTheQuestion")}
                        problem={problemAt(issues, "options", "questions")}
                    >
                        <Textarea
                            rows={4}
                            value={questionsText}
                            placeholder={t("editor.whatIsTheNameOf")}
                            onChange={(event) => {
                                setQuestionsText(event.target.value);
                                onChange({
                                    ...value,
                                    questions: readQuestions(event.target.value)
                                });
                            }}
                        />
                    </Field>
                </>
            );
        }
        case "explorer": {
            const value = preset.options as catalog.EventOptions<"explorer">;
            return (
                <>
                    <Field label={t("editor.theGoal")}>
                        <SegmentedControl
                            value={value.mode}
                            onValueChange={(mode) =>
                                onChange({ ...value, mode: mode as typeof value.mode })
                            }
                            options={[
                                { value: "distance", label: t("editor.farthestTravelled") },
                                { value: "race", label: t("editor.raceToAPoint") }
                            ]}
                            aria-label={t("editor.theGoal")}
                        />
                    </Field>
                    {value.mode === "race" && (
                        <>
                            <PlaceField
                                value={value.place}
                                onChange={(place) => onChange({ ...value, place })}
                                what={t("editor.place.finish")}
                                issues={issues}
                                path={["options", "place"]}
                            />
                            <Field
                                label={t("editor.howFarBlocks")}
                                hint={t("editor.between200And3000")}
                                problem={problemAt(issues, "options", "distance")}
                            >
                                <Input
                                    type="number"
                                    min={200}
                                    max={3000}
                                    value={Number.isFinite(value.distance) ? value.distance : ""}
                                    onChange={(event) =>
                                        onChange({
                                            ...value,
                                            distance: numberOf(event.target.value)
                                        })
                                    }
                                />
                            </Field>
                        </>
                    )}
                </>
            );
        }
        case "happy-hour": {
            const value = preset.options as catalog.EventOptions<"happy-hour">;
            const effects: {
                key: "haste" | "luck" | "speed" | "regeneration";
                label: string;
                hint: string;
            }[] = [
                {
                    key: "haste",
                    label: t("editor.hasteIi"),
                    hint: t("editor.miningAndDiggingFaster")
                },
                {
                    key: "luck",
                    label: t("editor.luck"),
                    hint: t("editor.betterFishingAndChestLoot")
                },
                { key: "speed", label: t("editor.speed"), hint: t("editor.movingFaster") },
                {
                    key: "regeneration",
                    label: t("editor.regeneration"),
                    hint: t("editor.healthComesBackOnIts")
                }
            ];
            return (
                <div className="flex flex-col gap-2">
                    {effects.map((effect) => (
                        <label
                            key={effect.key}
                            className="flex items-center justify-between gap-3 text-sm"
                        >
                            <span>
                                <span className="font-medium">{effect.label}</span>
                                <span className="block text-xs text-muted-foreground">
                                    {effect.hint}
                                </span>
                            </span>
                            <Switch
                                checked={value[effect.key]}
                                onChange={(on) => onChange({ ...value, [effect.key]: on })}
                                aria-label={effect.label}
                            />
                        </label>
                    ))}
                    <Problem text={problemAt(issues, "options")} />
                </div>
            );
        }
        case "king-of-the-hill": {
            const value = preset.options as catalog.EventOptions<"king-of-the-hill">;
            return (
                <>
                    <PlaceField
                        value={value.place}
                        onChange={(place) => onChange({ ...value, place })}
                        what={t("editor.place.circle")}
                        issues={issues}
                        path={["options", "place"]}
                    />
                    <Field
                        label={t("editor.circleRadiusBlocks")}
                        hint={t("editor.between3And20")}
                        problem={problemAt(issues, "options", "radius")}
                    >
                        <Input
                            type="number"
                            min={3}
                            max={20}
                            value={Number.isFinite(value.radius) ? value.radius : ""}
                            onChange={(event) =>
                                onChange({ ...value, radius: numberOf(event.target.value) })
                            }
                        />
                    </Field>
                    <label className="flex items-center justify-between gap-3 text-sm">
                        <span>
                            <span className="font-medium">{t("editor.fistsOnly")}</span>
                            <span className="block text-xs text-muted-foreground">
                                {t("editor.fistsOnlyHint")}
                            </span>
                        </span>
                        <Switch
                            checked={value.fistsOnly}
                            onChange={(on) => onChange({ ...value, fistsOnly: on })}
                            aria-label={t("editor.fistsOnly")}
                        />
                    </label>
                    {value.fistsOnly ? (
                        <>
                            <Field
                                label={t("editor.ringRounds")}
                                hint={t("editor.ringRoundsHint")}
                                problem={problemAt(issues, "options", "rounds")}
                            >
                                <Input
                                    type="number"
                                    min={1}
                                    max={5}
                                    value={Number.isFinite(value.rounds) ? value.rounds : ""}
                                    onChange={(event) =>
                                        onChange({ ...value, rounds: numberOf(event.target.value) })
                                    }
                                />
                            </Field>
                            <label className="flex items-center justify-between gap-3 text-sm">
                                <span className="min-w-0">
                                    <span className="font-medium">{t("editor.ringShrinks")}</span>
                                    <span className="block text-xs text-muted-foreground">
                                        {t("editor.ringShrinksHint")}
                                    </span>
                                </span>
                                <Switch
                                    checked={value.shrinks}
                                    onChange={(on) => onChange({ ...value, shrinks: on })}
                                    aria-label={t("editor.ringShrinks")}
                                />
                            </label>
                            <label className="flex items-center justify-between gap-3 text-sm">
                                <span className="min-w-0">
                                    <span className="font-medium">{t("editor.ringMoves")}</span>
                                    <span className="block text-xs text-muted-foreground">
                                        {t("editor.ringMovesHint")}
                                    </span>
                                </span>
                                <Switch
                                    checked={value.moves}
                                    onChange={(on) => onChange({ ...value, moves: on })}
                                    aria-label={t("editor.ringMoves")}
                                />
                            </label>
                        </>
                    ) : null}
                </>
            );
        }
        case "treasure-hunt":
            return (
                <TreasureHuntOptions
                    value={preset.options as catalog.EventOptions<"treasure-hunt">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "gathering":
            return (
                <GatheringOptions
                    value={preset.options as catalog.EventOptions<"gathering">}
                    issues={issues}
                    onChange={onChange}
                />
            );
        case "rare-catch":
            return (
                <RareCatchOptions
                    value={preset.options as catalog.EventOptions<"rare-catch">}
                    onChange={onChange}
                />
            );
        case "xp-boost":
            return (
                <XpBoostOptions
                    value={preset.options as catalog.EventOptions<"xp-boost">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "waves": {
            const value = preset.options as catalog.EventOptions<"waves">;
            return (
                <>
                    <PlaceField
                        value={value.place}
                        onChange={(place) => onChange({ ...value, place })}
                        what={t("editor.place.point")}
                        issues={issues}
                        path={["options", "place"]}
                    />
                    <div className="grid grid-cols-2 gap-3">
                        <Field
                            label={t("editor.waves")}
                            hint={t("editor.3To10")}
                            problem={problemAt(issues, "options", "waves")}
                        >
                            <Input
                                type="number"
                                min={3}
                                max={10}
                                value={Number.isFinite(value.waves) ? value.waves : ""}
                                onChange={(event) =>
                                    onChange({ ...value, waves: numberOf(event.target.value) })
                                }
                            />
                        </Field>
                        <Field
                            label={t("editor.firstWaveSize")}
                            hint={t("editor.2To12ForOne")}
                            problem={problemAt(issues, "options", "size")}
                        >
                            <Input
                                type="number"
                                min={2}
                                max={12}
                                value={Number.isFinite(value.size) ? value.size : ""}
                                onChange={(event) =>
                                    onChange({ ...value, size: numberOf(event.target.value) })
                                }
                            />
                        </Field>
                    </div>
                    <Field
                        label={t("editor.monsters")}
                        hint={t("editor.neverCreepersEndermenOrAnything")}
                    >
                        <Select
                            value={value.mix}
                            onValueChange={(mix) =>
                                onChange({ ...value, mix: mix as typeof value.mix })
                            }
                            options={options(t, WAVE_MIX_LABELS)}
                            aria-label={t("editor.monsters")}
                        />
                    </Field>
                    <Field label={t("editor.wavesWinner")}>
                        <SegmentedControl
                            value={value.winner}
                            onValueChange={(winner) =>
                                onChange({ ...value, winner: winner as typeof value.winner })
                            }
                            options={options(t, WAVE_WINNER_LABELS)}
                            aria-label={t("editor.wavesWinner")}
                        />
                    </Field>
                </>
            );
        }
        case "meteor-shower": {
            const value = preset.options as catalog.EventOptions<"meteor-shower">;
            return (
                <>
                    <PlaceField
                        value={value.place}
                        onChange={(place) => onChange({ ...value, place })}
                        what={t("editor.place.meteor")}
                        issues={issues}
                        path={["options", "place"]}
                    />
                    <Field
                        label={t("editor.howFarBlocks")}
                        hint={t("editor.between50And1000Around")}
                        problem={problemAt(issues, "options", "distance")}
                    >
                        <Input
                            type="number"
                            min={50}
                            max={1000}
                            value={Number.isFinite(value.distance) ? value.distance : ""}
                            onChange={(event) =>
                                onChange({ ...value, distance: numberOf(event.target.value) })
                            }
                        />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                        <Field
                            label={t("editor.meteors")}
                            hint={t("editor.range", { min: 2, max: 30 })}
                            problem={problemAt(issues, "options", "meteors")}
                        >
                            <Input
                                type="number"
                                min={2}
                                max={30}
                                value={Number.isFinite(value.meteors) ? value.meteors : ""}
                                onChange={(event) =>
                                    onChange({ ...value, meteors: numberOf(event.target.value) })
                                }
                            />
                        </Field>
                        <Field
                            label={t("editor.blocksInEach")}
                            hint={t("editor.3To12")}
                            problem={problemAt(issues, "options", "size")}
                        >
                            <Input
                                type="number"
                                min={3}
                                max={12}
                                value={Number.isFinite(value.size) ? value.size : ""}
                                onChange={(event) =>
                                    onChange({ ...value, size: numberOf(event.target.value) })
                                }
                            />
                        </Field>
                    </div>
                    <Field label={t("editor.madeOf")}>
                        <Select
                            value={value.ores}
                            onValueChange={(ores) =>
                                onChange({ ...value, ores: ores as typeof value.ores })
                            }
                            options={options(t, METEOR_ORE_LABELS)}
                            aria-label={t("editor.madeOf")}
                        />
                    </Field>
                    <label className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0">
                            <span className="font-medium">{t("editor.meteorInfection")}</span>
                            <span className="block text-xs text-muted-foreground">
                                {t("editor.meteorInfectionHint")}
                            </span>
                        </span>
                        <Switch
                            checked={value.infection}
                            onChange={(infection) => onChange({ ...value, infection })}
                            aria-label={t("editor.meteorInfection")}
                        />
                    </label>
                </>
            );
        }
        case "parkour": {
            const value = preset.options as catalog.EventOptions<"parkour">;
            return (
                <>
                    <PlaceField
                        value={value.place}
                        onChange={(place) => onChange({ ...value, place })}
                        what={t("editor.place.openGround")}
                        issues={issues}
                        path={["options", "place"]}
                    />
                    <div className="grid grid-cols-2 gap-3">
                        <Field
                            label={t("editor.jumps")}
                            hint={t("editor.10To60ACheckpoint")}
                            problem={problemAt(issues, "options", "jumps")}
                        >
                            <Input
                                type="number"
                                min={10}
                                max={60}
                                value={Number.isFinite(value.jumps) ? value.jumps : ""}
                                onChange={(event) =>
                                    onChange({ ...value, jumps: numberOf(event.target.value) })
                                }
                            />
                        </Field>
                        <Field
                            label={t("editor.heightBlocks")}
                            hint={t("editor.25To40AboveThe")}
                            problem={problemAt(issues, "options", "height")}
                        >
                            <Input
                                type="number"
                                min={25}
                                max={40}
                                value={Number.isFinite(value.height) ? value.height : ""}
                                onChange={(event) =>
                                    onChange({ ...value, height: numberOf(event.target.value) })
                                }
                            />
                        </Field>
                    </div>
                    <Field
                        label={t("editor.difficulty")}
                        hint={t("editor.easyWidePlatformsShortGaps")}
                    >
                        <SegmentedControl
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
                    <fieldset className="flex flex-col gap-2 text-sm">
                        <legend className="font-medium">{t("editor.parkourShapes")}</legend>
                        <span className="text-xs text-muted-foreground">
                            {t("editor.parkourShapesHint")}
                        </span>
                        {catalog.PARKOUR_SHAPES.map((shape) => {
                            const on = value.shapes.includes(shape);
                            return (
                                <label
                                    key={shape}
                                    className="flex items-center justify-between gap-3"
                                >
                                    <span className="min-w-0">{t(SHAPE_LABELS[shape])}</span>
                                    <Switch
                                        checked={on}
                                        // Never none: the last shape switched on stays on.
                                        disabled={on && value.shapes.length === 1}
                                        onChange={(next) =>
                                            onChange({
                                                ...value,
                                                shapes: catalog.PARKOUR_SHAPES.filter((one) =>
                                                    one === shape
                                                        ? next
                                                        : value.shapes.includes(one)
                                                )
                                            })
                                        }
                                        aria-label={t(SHAPE_LABELS[shape])}
                                    />
                                </label>
                            );
                        })}
                        <Problem text={problemAt(issues, "options", "shapes")} />
                    </fieldset>
                    <Field label={t("editor.courseLook")}>
                        <Select
                            value={value.theme}
                            onValueChange={(theme) =>
                                onChange({ ...value, theme: theme as typeof value.theme })
                            }
                            options={options(t, THEME_LABELS)}
                            aria-label={t("editor.courseLook")}
                        />
                    </Field>
                </>
            );
        }
        case "spleef": {
            const value = preset.options as catalog.EventOptions<"spleef">;
            return (
                <>
                    <PlaceField
                        value={value.place}
                        onChange={(place) => onChange({ ...value, place })}
                        what={t("editor.place.openGround")}
                        issues={issues}
                        path={["options", "place"]}
                    />
                    <div className="grid grid-cols-2 gap-3">
                        <Field
                            label={t("editor.floorSizeBlocksFromThe")}
                            hint={
                                Number.isFinite(value.size)
                                    ? t("editor.floorSizeHint", { size: value.size * 2 + 1 })
                                    : t("editor.5To15")
                            }
                            problem={problemAt(issues, "options", "size")}
                        >
                            <Input
                                type="number"
                                min={5}
                                max={15}
                                value={Number.isFinite(value.size) ? value.size : ""}
                                onChange={(event) =>
                                    onChange({ ...value, size: numberOf(event.target.value) })
                                }
                            />
                        </Field>
                        <Field
                            label={t("editor.heightBlocks")}
                            hint={t("editor.25To40AboveThe")}
                            problem={problemAt(issues, "options", "height")}
                        >
                            <Input
                                type="number"
                                min={25}
                                max={40}
                                value={Number.isFinite(value.height) ? value.height : ""}
                                onChange={(event) =>
                                    onChange({ ...value, height: numberOf(event.target.value) })
                                }
                            />
                        </Field>
                    </div>
                    <fieldset className="flex flex-col gap-2 text-sm">
                        <legend className="font-medium">{t("editor.spleefWays")}</legend>
                        <span className="text-xs text-muted-foreground">
                            {t("editor.spleefWaysHint")}
                        </span>
                        {catalog.SPLEEF_VARIANTS.map((way) => {
                            const on = value.variants.includes(way);
                            return (
                                <label
                                    key={way}
                                    className="flex items-center justify-between gap-3"
                                >
                                    <span className="min-w-0">{t(SPLEEF_LABELS[way])}</span>
                                    <Switch
                                        checked={on}
                                        // Never none: the last way switched on stays on.
                                        disabled={on && value.variants.length === 1}
                                        onChange={(next) =>
                                            onChange({
                                                ...value,
                                                variants: catalog.SPLEEF_VARIANTS.filter((one) =>
                                                    one === way
                                                        ? next
                                                        : value.variants.includes(one)
                                                )
                                            })
                                        }
                                        aria-label={t(SPLEEF_LABELS[way])}
                                    />
                                </label>
                            );
                        })}
                        <Problem text={problemAt(issues, "options", "variants")} />
                    </fieldset>
                </>
            );
        }
        case "team-duel":
            return (
                <TeamDuelFields
                    value={preset.options as catalog.EventOptions<"team-duel">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "build-battle":
            return (
                <BuildBattleFields
                    value={preset.options as catalog.EventOptions<"build-battle">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "tnt-run":
            return (
                <TntRunFields
                    value={preset.options as catalog.EventOptions<"tnt-run">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "boat-race":
            return (
                <BoatRaceFields
                    value={preset.options as catalog.EventOptions<"boat-race">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "dropper":
            return (
                <DropperFields
                    value={preset.options as catalog.EventOptions<"dropper">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "nether-maze":
            return (
                <NetherMazeFields
                    value={preset.options as catalog.EventOptions<"nether-maze">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "elytra-race":
            return (
                <ElytraRaceFields
                    value={preset.options as catalog.EventOptions<"elytra-race">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "acid-rain":
            return (
                <AcidRainFields
                    value={preset.options as catalog.EventOptions<"acid-rain">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "capture-the-flag":
            return (
                <CaptureTheFlagFields
                    value={preset.options as catalog.EventOptions<"capture-the-flag">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "hide-and-seek":
            return (
                <HideAndSeekFields
                    value={preset.options as catalog.EventOptions<"hide-and-seek">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "hot-potato":
            return (
                <HotPotatoFields
                    value={preset.options as catalog.EventOptions<"hot-potato">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "sky-wars":
            return (
                <SkyWarsFields
                    value={preset.options as catalog.EventOptions<"sky-wars">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "village-defense":
            return (
                <VillageDefenseFields
                    value={preset.options as catalog.EventOptions<"village-defense">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        case "bingo":
            return (
                <BingoFields
                    value={preset.options as catalog.EventOptions<"bingo">}
                    onChange={onChange}
                />
            );
        case "boss-fishing":
            return (
                <BossFishingFields
                    value={preset.options as catalog.EventOptions<"boss-fishing">}
                    onChange={onChange}
                    issues={issues}
                />
            );
        default:
            return null;
    }
}

export function EventEditor({
    preset: saved,
    isNew = false,
    version = null,
    open,
    onOpenChange,
    onSave
}: {
    preset: catalog.EventPreset;
    /** Being added, not edited: Done takes it as it is. */
    isNew?: boolean;
    /** The version the server runs, when known: an option this server cannot
     *  play is said beside the fields, and nothing is said otherwise. */
    version?: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave: (preset: catalog.EventPreset) => void;
}) {
    const t = useGameText("minecraft");
    const [draft, setDraft] = useState<catalog.EventPreset>(saved);
    const checked = useMemo(() => catalog.presetSchema.safeParse(draft), [draft]);
    const issues = checked.success ? [] : checked.error.issues;
    const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
    const info = catalog.KIND_INFO[draft.kind];
    const incompatible = incompatibleText(t, draft, version);
    const change = (patch: Partial<catalog.EventPreset>) =>
        setDraft((current) => ({ ...current, ...patch }) as catalog.EventPreset);
    const rewards = draft.rewards;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[min(40rem,95vw)] max-w-[min(40rem,95vw)]">
                <div className="flex flex-col gap-4">
                    <DialogHeader className="pr-8">
                        <DialogTitle>{kindLabel(t, draft.kind)}</DialogTitle>
                        <DialogDescription>{kindSummary(t, draft.kind)}</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                        <Field
                            label={t("editor.name")}
                            hint={t("editor.whatPlayersSeeInTitles")}
                            problem={problemAt(issues, "name")}
                        >
                            <Input
                                value={draft.name}
                                maxLength={40}
                                onChange={(event) => change({ name: event.target.value })}
                            />
                        </Field>
                        {draft.kind !== "trivia" &&
                            draft.kind !== "waves" &&
                            draft.kind !== "village-defense" &&
                            draft.kind !== "gathering" && (
                                <Field
                                    label={
                                        draft.kind === "build-battle"
                                            ? t("editor.minutesToBuild")
                                            : t("editor.minutes")
                                    }
                                    problem={problemAt(issues, "minutes")}
                                    hint={t("editor.range", {
                                        min: catalog.DURATION.min,
                                        max: catalog.DURATION.max
                                    })}
                                >
                                    <Input
                                        type="number"
                                        min={catalog.DURATION.min}
                                        max={catalog.DURATION.max}
                                        value={Number.isFinite(draft.minutes) ? draft.minutes : ""}
                                        onChange={(event) =>
                                            change({ minutes: numberOf(event.target.value) })
                                        }
                                    />
                                </Field>
                            )}
                    </div>

                    {catalog.hasMinScore(draft) && (
                        <Field
                            label={t("editor.leastRanked", { unit: kindUnit(t, draft.kind) })}
                            hint={t("editor.belowThisAPlayerIs")}
                            problem={problemAt(issues, "minScore")}
                        >
                            <Input
                                type="number"
                                min={1}
                                className="w-32"
                                value={
                                    Number.isFinite(catalog.minScoreOf(draft))
                                        ? catalog.minScoreOf(draft)
                                        : ""
                                }
                                onChange={(event) =>
                                    change({ minScore: numberOf(event.target.value) })
                                }
                            />
                        </Field>
                    )}

                    <Field
                        label={t("editor.minPlayers")}
                        hint={
                            catalog.takesJoiners(draft)
                                ? t("editor.minPlayersJoined")
                                : t("editor.minPlayersOnline")
                        }
                        problem={problemAt(issues, "minPlayers")}
                    >
                        <Input
                            type="number"
                            min={1}
                            max={50}
                            className="w-32"
                            value={
                                Number.isFinite(catalog.minPlayersOf(draft))
                                    ? catalog.minPlayersOf(draft)
                                    : ""
                            }
                            onChange={(event) =>
                                change({ minPlayers: numberOf(event.target.value) })
                            }
                        />
                    </Field>

                    <OptionsFields
                        preset={draft}
                        issues={issues}
                        onChange={(next) =>
                            change({ options: next } as Partial<catalog.EventPreset>)
                        }
                    />
                    {incompatible && (
                        <p role="status" className="text-xs text-warning">
                            {t("events.incompatible.badge")}: {incompatible}
                        </p>
                    )}

                    {info.competitive && (
                        <div className="flex flex-col gap-2">
                            <p className="text-sm font-medium">{t("editor.prizes")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("editor.givenWhenItEndsAnybody")}
                            </p>
                            <div className="grid gap-2 sm:grid-cols-2">
                                <RewardEditor
                                    label={t("editor.firstPlace")}
                                    hint={t("editor.tiesShareAPlace")}
                                    value={rewards.first}
                                    issues={issues}
                                    path={["rewards", "first"]}
                                    onChange={(first) => change({ rewards: { ...rewards, first } })}
                                />
                                <RewardEditor
                                    label={t("editor.secondPlace")}
                                    hint={t("editor.emptyPlaceGetsTheRest")}
                                    value={rewards.second}
                                    issues={issues}
                                    path={["rewards", "second"]}
                                    onChange={(second) =>
                                        change({ rewards: { ...rewards, second } })
                                    }
                                />
                                <RewardEditor
                                    label={t("editor.thirdPlace")}
                                    hint={t("editor.emptyPlaceGetsTheRest")}
                                    value={rewards.third}
                                    issues={issues}
                                    path={["rewards", "third"]}
                                    onChange={(third) => change({ rewards: { ...rewards, third } })}
                                />
                                <RewardEditor
                                    label={t("editor.everybodyWhoTookPart")}
                                    hint={
                                        draft.kind === "blood-moon"
                                            ? t("editor.everybodyWhoSurvivedTheNight")
                                            : draft.kind === "waves" ||
                                                draft.kind === "village-defense"
                                              ? t("editor.everybodyWhoHeldThePoint")
                                              : draft.kind === "parkour"
                                                ? t("editor.everybodyWhoJoinedAndCleared")
                                                : draft.kind === "spleef" ||
                                                    draft.kind === "tnt-run" ||
                                                    catalog.lastStanding(draft)
                                                  ? t("editor.everybodyWhoJoined")
                                                  : draft.kind === "supply-drop" ||
                                                      draft.kind === "rare-catch" ||
                                                      (draft.kind === "explorer" &&
                                                          (
                                                              draft.options as catalog.EventOptions<"explorer">
                                                          ).mode === "race")
                                                    ? t("editor.nobodyButTheWinnerIn")
                                                    : t("editor.everybodyWhoScoredAtAll")
                                    }
                                    value={rewards.everyone}
                                    issues={issues}
                                    path={["rewards", "everyone"]}
                                    onChange={(everyone) =>
                                        change({ rewards: { ...rewards, everyone } })
                                    }
                                />
                            </div>
                        </div>
                    )}

                    <div className="flex items-center justify-end gap-2">
                        {!checked.success && issues[0] && (
                            <Problem className="mr-auto" text={issues[0].message} />
                        )}
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            {t("editor.cancel")}
                        </Button>
                        <Button
                            // A new event is saved as it opens: its defaults are
                            // a choice too, and nothing has to be changed first.
                            disabled={!checked.success || (!dirty && !isNew)}
                            onClick={() => {
                                if (checked.success) onSave(checked.data);
                            }}
                        >
                            {t("editor.done")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
