"use client";

/**
 * The options of the events players join and are taken somewhere for: a team
 * duel's kit and when a player is out, a build battle's plots, vote and theme.
 */

import { useState } from "react";
import * as catalog from "../../lib/minecraft/events/catalog";
import { Input, SegmentedControl, Select, Textarea } from "@polaris/ui";
import { Field, PlaceField, numberOf, options, problemAt } from "./event-editor";

type Issues = readonly { path: (string | number)[]; message: string }[];

const KIT_LABELS: Readonly<Record<(typeof catalog.DUEL_KITS)[number], string>> = {
    wood: "Wooden sword and shield",
    stone: "Stone sword and shield",
    iron: "Iron sword and shield"
};

const THEME_LABELS: Readonly<Record<(typeof catalog.THEME_MODES)[number], string>> = {
    random: "Built-in",
    mine: "My own"
};

export function TeamDuelFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"team-duel">;
    onChange: (options: catalog.EventOptions<"team-duel">) => void;
    issues: Issues;
}) {
    return (
        <>
            <Field label="Kit" hint="The same for everybody, and taken back at the end.">
                <Select
                    value={value.kit}
                    onValueChange={(kit) => onChange({ ...value, kit: kit as typeof value.kit })}
                    options={options(KIT_LABELS)}
                    aria-label="Kit"
                />
            </Field>
            <Field
                label="Out at (hearts)"
                hint="1 to 6. A player this low is sent back to their side, healed, and the other team scores."
                problem={problemAt(issues, "options", "downHearts")}
            >
                <Input
                    type="number"
                    min={1}
                    max={6}
                    className="w-32"
                    value={Number.isFinite(value.downHearts) ? value.downHearts : ""}
                    onChange={(event) =>
                        onChange({ ...value, downHearts: numberOf(event.target.value) })
                    }
                />
            </Field>
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what="The arena is built 30 blocks up, about 30 blocks"
                issues={issues}
                path={["options", "place"]}
            />
        </>
    );
}

export function BuildBattleFields({
    value,
    onChange,
    issues
}: {
    value: catalog.EventOptions<"build-battle">;
    onChange: (options: catalog.EventOptions<"build-battle">) => void;
    issues: Issues;
}) {
    const [themesText, setThemesText] = useState(() => value.themes.join("\n"));
    return (
        <>
            <div className="grid grid-cols-2 gap-3">
                <Field
                    label="Plot size (blocks)"
                    hint="7 to 15 a side, as tall as it is wide"
                    problem={problemAt(issues, "options", "plotSize")}
                >
                    <Input
                        type="number"
                        min={7}
                        max={15}
                        value={Number.isFinite(value.plotSize) ? value.plotSize : ""}
                        onChange={(event) =>
                            onChange({ ...value, plotSize: numberOf(event.target.value) })
                        }
                    />
                </Field>
                <Field
                    label="Seconds to vote"
                    hint="30 to 180, after the building time"
                    problem={problemAt(issues, "options", "voteSeconds")}
                >
                    <Input
                        type="number"
                        min={30}
                        max={180}
                        value={Number.isFinite(value.voteSeconds) ? value.voteSeconds : ""}
                        onChange={(event) =>
                            onChange({ ...value, voteSeconds: numberOf(event.target.value) })
                        }
                    />
                </Field>
            </div>
            <Field label="Theme">
                <SegmentedControl
                    value={value.themeMode}
                    onValueChange={(themeMode) =>
                        onChange({ ...value, themeMode: themeMode as typeof value.themeMode })
                    }
                    options={options(THEME_LABELS)}
                    aria-label="Theme"
                />
            </Field>
            {value.themeMode === "mine" ? (
                <Field
                    label="Your themes"
                    hint="One a line; one is drawn each time."
                    problem={problemAt(issues, "options", "themes")}
                >
                    <Textarea
                        rows={4}
                        value={themesText}
                        placeholder={"Our spawn town\nA dragon"}
                        onChange={(event) => {
                            setThemesText(event.target.value);
                            onChange({
                                ...value,
                                themes: event.target.value
                                    .split("\n")
                                    .map((line) => line.trim())
                                    .filter(Boolean)
                            });
                        }}
                    />
                </Field>
            ) : (
                <span className="text-xs text-muted-foreground">
                    One of 30 built-in themes, in the players&apos; language.
                </span>
            )}
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what="The plots are built 30 blocks up, about 30 blocks"
                issues={issues}
                path={["options", "place"]}
            />
        </>
    );
}
