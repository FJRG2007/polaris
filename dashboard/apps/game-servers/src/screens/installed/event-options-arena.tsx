"use client";

/**
 * The options of the events players join and are taken somewhere for: a team
 * duel's kit and when a player is out, a build battle's plots, vote and theme.
 */

import { useState } from "react";
import * as catalog from "../../lib/minecraft/events/catalog";
import { Input, SegmentedControl, Select, Textarea } from "@polaris/ui";
import { Field, PlaceField, numberOf, options, problemAt } from "./event-editor";
import { useGameText } from "../game-text";
import type { GameKey } from "../../../messages";

type Issues = readonly { path: (string | number)[]; message: string }[];

const KIT_LABELS: Readonly<Record<(typeof catalog.DUEL_KITS)[number], GameKey<"minecraft">>> = {
    wood: "editor.labels.kit.wood",
    stone: "editor.labels.kit.stone",
    iron: "editor.labels.kit.iron"
};

const THEME_LABELS: Readonly<Record<(typeof catalog.THEME_MODES)[number], GameKey<"minecraft">>> = {
    random: "editor.labels.theme.random",
    mine: "editor.labels.theme.mine"
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
            <Field
                label={t("editor.outAtHearts")}
                hint={t("editor.outAtHint")}
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
                what={t("editor.place.arena")}
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
    const t = useGameText("minecraft");
    const [themesText, setThemesText] = useState(() => value.themes.join("\n"));
    return (
        <>
            <div className="grid grid-cols-2 gap-3">
                <Field
                    label={t("editor.plotSize")}
                    hint={t("editor.plotSizeHint")}
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
                    label={t("editor.secondsToVote")}
                    hint={t("editor.voteHint")}
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
            <Field label={t("editor.theme")}>
                <SegmentedControl
                    value={value.themeMode}
                    onValueChange={(themeMode) =>
                        onChange({ ...value, themeMode: themeMode as typeof value.themeMode })
                    }
                    options={options(t, THEME_LABELS)}
                    aria-label={t("editor.theme")}
                />
            </Field>
            {value.themeMode === "mine" ? (
                <Field
                    label={t("editor.yourThemes")}
                    hint={t("editor.themesHint")}
                    problem={problemAt(issues, "options", "themes")}
                >
                    <Textarea
                        rows={4}
                        value={themesText}
                        placeholder={t("editor.themesPlaceholder")}
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
                <span className="text-xs text-muted-foreground">{t("editor.builtInThemes")}</span>
            )}
            <PlaceField
                value={value.place}
                onChange={(place) => onChange({ ...value, place })}
                what={t("editor.place.plots")}
                issues={issues}
                path={["options", "place"]}
            />
        </>
    );
}
