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
import { useGameText, type GameText } from "../game-text";
import type { GameKey } from "../../../messages";
import { kindUnit } from "./event-kinds";
import { Plus, Trash2 } from "lucide-react";
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

const BOSS_LABELS: Readonly<Record<(typeof catalog.BOSS_KINDS)[number], GameKey<"minecraft">>> = {
    "wither-skeleton": "editor.labels.boss.wither-skeleton",
    ravager: "editor.labels.boss.ravager",
    vindicator: "editor.labels.boss.vindicator",
    husk: "editor.labels.boss.husk"
};

const INTENSITY_LABELS: Readonly<
    Record<(typeof catalog.INTENSITIES)[number], GameKey<"minecraft">>
> = {
    low: "editor.labels.intensity.low",
    medium: "editor.labels.intensity.medium",
    high: "editor.labels.intensity.high"
};

const WAVE_MIX_LABELS: Readonly<Record<(typeof catalog.WAVE_MIXES)[number], GameKey<"minecraft">>> =
    {
        classic: "editor.labels.waveMix.classic",
        undead: "editor.labels.waveMix.undead",
        mixed: "editor.labels.waveMix.mixed"
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

const DIFFICULTY_LABELS: Readonly<
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
                <span className="text-xs text-danger">{problem}</span>
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
    return (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
            {value.items.map((item, index) => (
                <div key={index} className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                        <Input
                            value={item.id}
                            placeholder="minecraft:diamond"
                            aria-label={t("editor.item")}
                            onChange={(event) =>
                                onChange({
                                    ...value,
                                    items: value.items.map((one, at) =>
                                        at === index ? { ...one, id: event.target.value } : one
                                    )
                                })
                            }
                        />
                        {problemAt(issues, ...path, "items", index, "id") && (
                            <span className="text-xs text-danger">
                                {problemAt(issues, ...path, "items", index, "id")}
                            </span>
                        )}
                    </div>
                    <Input
                        className="w-20"
                        type="number"
                        min={1}
                        max={256}
                        aria-label={t("editor.howMany")}
                        value={Number.isFinite(item.count) ? item.count : ""}
                        onChange={(event) =>
                            onChange({
                                ...value,
                                items: value.items.map((one, at) =>
                                    at === index
                                        ? { ...one, count: numberOf(event.target.value) }
                                        : one
                                )
                            })
                        }
                    />
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("editor.removeThisItem")}
                        title={t("editor.removeThisItem")}
                        onClick={() =>
                            onChange({
                                ...value,
                                items: value.items.filter((_, at) => at !== index)
                            })
                        }
                    >
                        <Trash2 className="size-4" />
                    </Button>
                </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
                {value.items.length < 6 && (
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                            onChange({
                                ...value,
                                items: [...value.items, { id: "minecraft:diamond", count: 1 }]
                            })
                        }
                    >
                        <Plus className="size-4" />
                        {t("editor.item")}
                    </Button>
                )}
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
            {problemAt(issues, ...path, "levels") && (
                <span className="text-xs text-danger">{problemAt(issues, ...path, "levels")}</span>
            )}
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
        case "world-boss": {
            const value = preset.options as catalog.EventOptions<"world-boss">;
            return (
                <>
                    <Field label={t("editor.whichBoss")}>
                        <Select
                            value={value.boss}
                            onValueChange={(boss) =>
                                onChange({ ...value, boss: boss as typeof value.boss })
                            }
                            options={options(t, BOSS_LABELS)}
                            aria-label={t("editor.whichBoss")}
                        />
                    </Field>
                    <Field
                        label={t("editor.health")}
                        hint={t("editor.between100And1024A")}
                        problem={problemAt(issues, "options", "health")}
                    >
                        <Input
                            type="number"
                            min={100}
                            max={1024}
                            value={Number.isFinite(value.health) ? value.health : ""}
                            onChange={(event) =>
                                onChange({ ...value, health: numberOf(event.target.value) })
                            }
                        />
                    </Field>
                    <PlaceField
                        value={value.place}
                        onChange={(place) => onChange({ ...value, place })}
                        what={t("editor.place.boss")}
                        issues={issues}
                        path={["options", "place"]}
                    />
                </>
            );
        }
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
                    {problemAt(issues, "options") && (
                        <span className="text-xs text-danger">{problemAt(issues, "options")}</span>
                    )}
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
                            hint={t("editor.2To8")}
                            problem={problemAt(issues, "options", "meteors")}
                        >
                            <Input
                                type="number"
                                min={2}
                                max={8}
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
                            hint={t("editor.10To40ACheckpoint")}
                            problem={problemAt(issues, "options", "jumps")}
                        >
                            <Input
                                type="number"
                                min={10}
                                max={40}
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
        default:
            return null;
    }
}

export function EventEditor({
    preset: saved,
    open,
    onOpenChange,
    onSave
}: {
    preset: catalog.EventPreset;
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
    const change = (patch: Partial<catalog.EventPreset>) =>
        setDraft((current) => ({ ...current, ...patch }) as catalog.EventPreset);
    const rewards = draft.rewards;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[min(40rem,95vw)] max-w-[min(40rem,95vw)]">
                <div className="flex flex-col gap-4">
                    <DialogHeader className="pr-8">
                        <DialogTitle>{info.label}</DialogTitle>
                        <DialogDescription>{info.summary}</DialogDescription>
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
                        {draft.kind !== "trivia" && draft.kind !== "waves" && (
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

                    <OptionsFields
                        preset={draft}
                        issues={issues}
                        onChange={(next) =>
                            change({ options: next } as Partial<catalog.EventPreset>)
                        }
                    />

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
                                    hint=""
                                    value={rewards.second}
                                    issues={issues}
                                    path={["rewards", "second"]}
                                    onChange={(second) =>
                                        change({ rewards: { ...rewards, second } })
                                    }
                                />
                                <RewardEditor
                                    label={t("editor.thirdPlace")}
                                    hint=""
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
                                            : draft.kind === "waves"
                                              ? t("editor.everybodyWhoHeldThePoint")
                                              : draft.kind === "parkour"
                                                ? t("editor.everybodyWhoJoinedAndCleared")
                                                : draft.kind === "spleef"
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
                            <span className="mr-auto text-xs text-danger">{issues[0].message}</span>
                        )}
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            {t("editor.cancel")}
                        </Button>
                        <Button
                            disabled={!checked.success || !dirty}
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
