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

const MINING_LABELS: Readonly<Record<(typeof catalog.MINING_TARGETS)[number], string>> = {
    "any-ore": "Any ore, rarer worth more",
    diamond: "Diamonds only",
    debris: "Ancient debris only"
};

const HUNT_LABELS: Readonly<Record<(typeof catalog.HUNT_TARGETS)[number], string>> = {
    hostile: "Every hostile mob, the dangerous worth more",
    zombie: "Zombies",
    skeleton: "Skeletons",
    creeper: "Creepers",
    spider: "Spiders",
    enderman: "Endermen"
};

const LOOT_LABELS: Readonly<Record<(typeof catalog.LOOT_TABLES)[number], string>> = {
    treasure: "Buried treasure",
    dungeon: "Dungeon",
    bastion: "Bastion treasure (1.16+)",
    "end-city": "End city",
    "ancient-city": "Ancient city (1.19+)"
};

const BOSS_LABELS: Readonly<Record<(typeof catalog.BOSS_KINDS)[number], string>> = {
    "wither-skeleton": "The Warlord (wither skeleton)",
    ravager: "The Juggernaut (ravager)",
    vindicator: "The Executioner (vindicator)",
    husk: "The Desert King (husk)"
};

const INTENSITY_LABELS: Readonly<Record<(typeof catalog.INTENSITIES)[number], string>> = {
    low: "Low",
    medium: "Medium",
    high: "High"
};

const TRIVIA_LABELS: Readonly<Record<(typeof catalog.TRIVIA_MODES)[number], string>> = {
    questions: "Questions",
    scramble: "Scrambled words",
    mixed: "Both, taking turns"
};

function options<T extends string>(
    labels: Readonly<Record<T, string>>
): { value: T; label: string }[] {
    return (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));
}

/** A number typed into a field, or NaN - which the schema then names. */
function numberOf(text: string): number {
    return text.trim() === "" ? Number.NaN : Number(text);
}

/** The first problem the schema has with a path, if any. */
function problemAt(
    issues: readonly { path: (string | number)[]; message: string }[],
    ...path: (string | number)[]
): string | null {
    const found = issues.find((issue) => path.every((part, index) => issue.path[index] === part));
    return found?.message ?? null;
}

function Field({
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
function PlaceField({
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
    return (
        <div className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Where</span>
            <SegmentedControl
                value={value.mode}
                onValueChange={(mode) =>
                    onChange(mode === "fixed" ? { mode: "fixed", x: 0, z: 0 } : { mode: "players" })
                }
                options={[
                    { value: "players", label: "Near the players" },
                    { value: "fixed", label: "At set coordinates" }
                ]}
                aria-label="Where it happens"
            />
            {value.mode === "fixed" ? (
                <div className="grid grid-cols-2 gap-2">
                    <Field label="X" problem={problemAt(issues, ...path, "x")}>
                        <Input
                            type="number"
                            value={Number.isFinite(value.x) ? value.x : ""}
                            onChange={(event) =>
                                onChange({ ...value, x: numberOf(event.target.value) })
                            }
                        />
                    </Field>
                    <Field label="Z" problem={problemAt(issues, ...path, "z")}>
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
                <span className="text-xs text-muted-foreground">
                    {what} around a player who is in the Overworld when it starts.
                </span>
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
                            aria-label="Item"
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
                        aria-label="How many"
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
                        aria-label="Remove this item"
                        title="Remove this item"
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
                        Item
                    </Button>
                )}
                <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    Levels
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
    const [questionsText, setQuestionsText] = useState(() =>
        preset.kind === "trivia"
            ? writeQuestions((preset.options as catalog.EventOptions<"trivia">).questions)
            : ""
    );
    switch (preset.kind) {
        case "mining-rush": {
            const value = preset.options as catalog.EventOptions<"mining-rush">;
            return (
                <Field label="What counts">
                    <Select
                        value={value.target}
                        onValueChange={(target) =>
                            onChange({ ...value, target: target as typeof value.target })
                        }
                        options={options(MINING_LABELS)}
                        aria-label="What counts"
                    />
                </Field>
            );
        }
        case "mob-hunt": {
            const value = preset.options as catalog.EventOptions<"mob-hunt">;
            return (
                <Field label="What counts">
                    <Select
                        value={value.target}
                        onValueChange={(target) =>
                            onChange({ ...value, target: target as typeof value.target })
                        }
                        options={options(HUNT_LABELS)}
                        aria-label="What counts"
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
                        what="It lands up to the distance below"
                        issues={issues}
                        path={["options", "place"]}
                    />
                    <Field
                        label="How far (blocks)"
                        hint="Between 100 and 3000. Around the players, or around the coordinates."
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
                    <Field label="What is inside">
                        <Select
                            value={value.loot}
                            onValueChange={(loot) =>
                                onChange({ ...value, loot: loot as typeof value.loot })
                            }
                            options={options(LOOT_LABELS)}
                            aria-label="What is inside"
                        />
                    </Field>
                </>
            );
        }
        case "blood-moon": {
            const value = preset.options as catalog.EventOptions<"blood-moon">;
            return (
                <>
                    <Field
                        label="How hard"
                        hint="How many mobs rise around each player every 40 seconds: 2, 3 or 5."
                    >
                        <SegmentedControl
                            value={value.intensity}
                            onValueChange={(intensity) =>
                                onChange({
                                    ...value,
                                    intensity: intensity as typeof value.intensity
                                })
                            }
                            options={options(INTENSITY_LABELS)}
                            aria-label="How hard"
                        />
                    </Field>
                    <label className="flex items-center justify-between gap-3 text-sm">
                        <span>
                            <span className="font-medium">Creepers too</span>
                            <span className="block text-xs text-muted-foreground">
                                They blow holes in whatever is built nearby.
                            </span>
                        </span>
                        <Switch
                            checked={value.creepers}
                            onChange={(creepers) => onChange({ ...value, creepers })}
                            aria-label="Creepers too"
                        />
                    </label>
                </>
            );
        }
        case "world-boss": {
            const value = preset.options as catalog.EventOptions<"world-boss">;
            return (
                <>
                    <Field label="Which boss">
                        <Select
                            value={value.boss}
                            onValueChange={(boss) =>
                                onChange({ ...value, boss: boss as typeof value.boss })
                            }
                            options={options(BOSS_LABELS)}
                            aria-label="Which boss"
                        />
                    </Field>
                    <Field
                        label="Health"
                        hint="Between 100 and 1024. A player with iron gear deals about 8 a hit."
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
                        what="It appears about 20 blocks"
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
                            label="Rounds"
                            problem={problemAt(issues, "options", "rounds")}
                            hint="3 to 15"
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
                            label="Seconds a round"
                            problem={problemAt(issues, "options", "seconds")}
                            hint="15 to 90"
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
                    <Field label="Rounds of">
                        <SegmentedControl
                            value={value.mode}
                            onValueChange={(mode) =>
                                onChange({ ...value, mode: mode as typeof value.mode })
                            }
                            options={options(TRIVIA_LABELS)}
                            aria-label="Rounds of"
                        />
                    </Field>
                    <Field
                        label="Your own questions"
                        hint="One a line: the question, a bar, then the answers that count, separated by semicolons. Asked before the built-in ones."
                        problem={problemAt(issues, "options", "questions")}
                    >
                        <Textarea
                            rows={4}
                            value={questionsText}
                            placeholder="What is the name of our spawn town? | Northwatch; north watch"
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
                    <Field label="The goal">
                        <SegmentedControl
                            value={value.mode}
                            onValueChange={(mode) =>
                                onChange({ ...value, mode: mode as typeof value.mode })
                            }
                            options={[
                                { value: "distance", label: "Farthest travelled" },
                                { value: "race", label: "Race to a point" }
                            ]}
                            aria-label="The goal"
                        />
                    </Field>
                    {value.mode === "race" && (
                        <>
                            <PlaceField
                                value={value.place}
                                onChange={(place) => onChange({ ...value, place })}
                                what="The finish is set the distance below"
                                issues={issues}
                                path={["options", "place"]}
                            />
                            <Field
                                label="How far (blocks)"
                                hint="Between 200 and 3000."
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
                { key: "haste", label: "Haste II", hint: "Mining and digging faster." },
                { key: "luck", label: "Luck", hint: "Better fishing and chest loot." },
                { key: "speed", label: "Speed", hint: "Moving faster." },
                {
                    key: "regeneration",
                    label: "Regeneration",
                    hint: "Health comes back on its own."
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
                        what="The circle is drawn about 30 blocks"
                        issues={issues}
                        path={["options", "place"]}
                    />
                    <Field
                        label="Circle radius (blocks)"
                        hint="Between 3 and 20."
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
                            label="Name"
                            hint="What players see in titles and on the scoreboard."
                            problem={problemAt(issues, "name")}
                        >
                            <Input
                                value={draft.name}
                                maxLength={40}
                                onChange={(event) => change({ name: event.target.value })}
                            />
                        </Field>
                        {draft.kind !== "trivia" && (
                            <Field
                                label="Minutes"
                                problem={problemAt(issues, "minutes")}
                                hint={`${catalog.DURATION.min} to ${catalog.DURATION.max}`}
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
                            label={`Least to be ranked (${catalog.KIND_INFO[draft.kind].unit})`}
                            hint="Below this a player is not on the podium and gets no prize for taking part. Nobody reaching it means nobody wins."
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
                            <p className="text-sm font-medium">Prizes</p>
                            <p className="text-xs text-muted-foreground">
                                Given when it ends. Anybody offline by then gets theirs the next
                                time they are on. Players caught by the anti-cheat during it get
                                nothing.
                            </p>
                            <div className="grid gap-2 sm:grid-cols-2">
                                <RewardEditor
                                    label="First place"
                                    hint="Ties share a place."
                                    value={rewards.first}
                                    issues={issues}
                                    path={["rewards", "first"]}
                                    onChange={(first) => change({ rewards: { ...rewards, first } })}
                                />
                                <RewardEditor
                                    label="Second place"
                                    hint=""
                                    value={rewards.second}
                                    issues={issues}
                                    path={["rewards", "second"]}
                                    onChange={(second) =>
                                        change({ rewards: { ...rewards, second } })
                                    }
                                />
                                <RewardEditor
                                    label="Third place"
                                    hint=""
                                    value={rewards.third}
                                    issues={issues}
                                    path={["rewards", "third"]}
                                    onChange={(third) => change({ rewards: { ...rewards, third } })}
                                />
                                <RewardEditor
                                    label="Everybody who took part"
                                    hint={
                                        draft.kind === "blood-moon"
                                            ? "Everybody who survived the night."
                                            : draft.kind === "supply-drop" ||
                                                (draft.kind === "explorer" &&
                                                    (
                                                        draft.options as catalog.EventOptions<"explorer">
                                                    ).mode === "race")
                                              ? "Nobody but the winner, in this one."
                                              : "Everybody who scored at all."
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
                            Cancel
                        </Button>
                        <Button
                            disabled={!checked.success || !dirty}
                            onClick={() => {
                                if (checked.success) onSave(checked.data);
                            }}
                        >
                            Done
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
