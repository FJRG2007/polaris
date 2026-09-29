"use client";

/**
 * One line of the side panel, or its title, with everything it can do beyond
 * saying one thing: take turns between several texts, and move.
 *
 * The first text is the field that is always there. The rest opens under it
 * from the sparkle beside the field's own buttons, and says in one line on the
 * closed field what the line does, so a panel of fifteen lines can be read
 * without opening each one.
 */

import { useState } from "react";
import type { GameKey } from "../../../messages";
import { useGameText, type GameText } from "../game-text";
import { FieldNote } from "./minecraft-announce";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import { FormattedTextField } from "../../components/formatted-text-field";
import { EFFECT_DEFAULT_COLORS } from "../../lib/minecraft/sidebar-effects";
import { Button, ColorPicker, Select, SegmentedControl, cn } from "@polaris/ui";
import { WholeNumberInput } from "../../components/whole-number-input";
import * as side from "../../lib/minecraft/sidebar";
import type { KnownValues } from "../../lib/minecraft/text-vars";

/** What each effect is called, and what it does, in a few words - under
 *  `lineEditor.effects.<kind>` in the catalogs. */
function effectName(t: GameText<"minecraft">, kind: side.SidebarEffectKind): string {
    return t(`lineEditor.effects.${kind}.name`);
}

function effectHint(t: GameText<"minecraft">, kind: side.SidebarEffectKind): string {
    return t(`lineEditor.effects.${kind}.hint`);
}

const SPEED_LABEL: Readonly<Record<side.SidebarSpeed, GameKey<"minecraft">>> = {
    2000: "lineEditor.speeds.slow",
    1000: "lineEditor.speeds.normal",
    500: "lineEditor.speeds.fast"
};

/** Which of an effect's colours can be chosen, and what each is called. */
const EFFECT_COLORS: Readonly<
    Partial<Record<side.SidebarEffectKind, readonly GameKey<"minecraft">[]>>
> = {
    wave: ["lineEditor.colors.from", "lineEditor.colors.to"],
    shine: ["lineEditor.colors.glint"],
    blink: ["lineEditor.colors.dimmedTo"]
};

/** What a line does beyond its first text, in one line, or null when nothing. */
export function lineSummary(t: GameText<"minecraft">, line: side.SidebarLine): string | null {
    const parts: string[] = [];
    if (line.frames.length > 1)
        parts.push(t("lineEditor.texts", { count: line.frames.length, every: line.every }));
    if (line.effect.kind !== "none") parts.push(effectName(t, line.effect.kind));
    return parts.length > 0 ? parts.join(" · ") : null;
}

export function SidebarLineEditor({
    line,
    onChange,
    label,
    fits,
    problems,
    inserts,
    placeholder,
    disabled,
    known
}: {
    line: side.SidebarLine;
    onChange: (next: side.SidebarLine) => void;
    /** "Title" or "Line 3", for screen readers and the settings' heading. */
    label: string;
    /** How many characters fit across the panel on this line. */
    fits: number;
    /** One per text, null where it is fine. */
    problems: readonly (string | null)[];
    inserts: Parameters<typeof FormattedTextField>[0]["inserts"];
    placeholder?: string;
    disabled?: boolean;
    /** The server's values already settled, for the counters. */
    known?: KnownValues;
}) {
    const t = useGameText("minecraft");
    const [open, setOpen] = useState(false);
    const summary = lineSummary(t, line);
    const max = side.textMax(line, fits);
    const setFrame = (index: number, value: string) =>
        onChange({
            ...line,
            frames: line.frames.map((frame, at) => (at === index ? value : frame))
        });
    const setEffect = (patch: Partial<side.SidebarLine["effect"]>) =>
        onChange({ ...line, effect: { ...line.effect, ...patch } });
    const colorNames = (EFFECT_COLORS[line.effect.kind] ?? []).map((key) => t(key));

    return (
        <div className="flex min-w-0 flex-col gap-2">
            <FormattedTextField
                value={line.frames[0] ?? ""}
                onChange={(value) => setFrame(0, value)}
                rows={1}
                singleLine
                label={label}
                placeholder={placeholder}
                inserts={inserts}
                actions={
                    <Button
                        type="button"
                        size="sm"
                        variant={open || summary ? "secondary" : "ghost"}
                        onClick={() => setOpen((shown) => !shown)}
                        aria-expanded={open}
                        aria-label={t("lineEditor.animateLabel", { line: label.toLowerCase() })}
                        title={t("lineEditor.takeTurnsBetweenTextsOr")}
                    >
                        <Sparkles className="size-3.5" />
                        {t("lineEditor.animate")}
                    </Button>
                }
                footnote={
                    <span className="flex flex-col">
                        <FieldNote
                            text={line.frames[0] ?? ""}
                            known={known}
                            max={max}
                            problem={problems[0] ?? undefined}
                        />
                        {summary && !open ? (
                            <span className="text-xs text-primary">{summary}</span>
                        ) : null}
                    </span>
                }
            />

            {open ? (
                <fieldset
                    disabled={disabled}
                    className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-3"
                >
                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-medium">{t("lineEditor.takeTurnsWith")}</span>
                        {line.frames.slice(1).map((frame, offset) => {
                            const index = offset + 1;
                            return (
                                <div key={index} className="flex items-start gap-1">
                                    <div className="min-w-0 flex-1">
                                        <FormattedTextField
                                            value={frame}
                                            onChange={(value) => setFrame(index, value)}
                                            rows={1}
                                            singleLine
                                            label={t("lineEditor.textLabel", {
                                                line: label,
                                                number: index + 1
                                            })}
                                            placeholder={t("lineEditor.leaveEmptyForAGap")}
                                            inserts={inserts}
                                            footnote={
                                                <FieldNote
                                                    text={frame}
                                                    known={known}
                                                    max={max}
                                                    problem={problems[index] ?? undefined}
                                                />
                                            }
                                        />
                                    </div>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        disabled={disabled}
                                        onClick={() =>
                                            onChange({
                                                ...line,
                                                frames: line.frames.filter((_, at) => at !== index)
                                            })
                                        }
                                        aria-label={t("lineEditor.removeTextOf", {
                                            number: index + 1,
                                            line: label.toLowerCase()
                                        })}
                                        title={t("lineEditor.removeText", { number: index + 1 })}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            );
                        })}
                        <div className="flex flex-wrap items-center gap-3">
                            <Button
                                variant="secondary"
                                size="sm"
                                disabled={disabled || line.frames.length >= side.SIDEBAR_FRAMES_MAX}
                                onClick={() =>
                                    onChange({
                                        ...line,
                                        frames: [...line.frames, line.frames[0] ?? ""]
                                    })
                                }
                            >
                                <Plus className="size-4" /> {t("lineEditor.addAText")}
                            </Button>
                            {line.frames.length > 1 ? (
                                <label className="flex items-center gap-2 text-xs">
                                    {t("lineEditor.eachFor")}
                                    <WholeNumberInput
                                        min={side.SIDEBAR_EVERY_MIN}
                                        max={side.SIDEBAR_EVERY_MAX}
                                        value={line.every}
                                        onValueChange={(every) => onChange({ ...line, every })}
                                        className="h-8 w-20"
                                        aria-label={t("lineEditor.secondsLabel", {
                                            line: label.toLowerCase()
                                        })}
                                    />
                                    {t("lineEditor.seconds")}
                                </label>
                            ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {t("lineEditor.linesThatChangeEveryAs")}
                        </p>
                    </div>

                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-medium">{t("lineEditor.effect")}</span>
                        <div className="flex flex-wrap items-center gap-2">
                            <Select
                                value={line.effect.kind}
                                onValueChange={(value) => {
                                    const kind =
                                        side.SIDEBAR_EFFECTS.find((one) => one === value) ?? "none";
                                    setEffect(
                                        kind === "none"
                                            ? side.NO_EFFECT
                                            : {
                                                  kind,
                                                  colors: [...(EFFECT_DEFAULT_COLORS[kind] ?? [])]
                                              }
                                    );
                                }}
                                options={side.SIDEBAR_EFFECTS.map((kind) => ({
                                    value: kind,
                                    label: effectName(t, kind)
                                }))}
                                disabled={disabled}
                                className="w-40"
                                aria-label={t("lineEditor.effectOn", { line: label.toLowerCase() })}
                            />
                            {line.effect.kind !== "none" ? (
                                <SegmentedControl
                                    value={String(line.effect.speed)}
                                    onValueChange={(value) => {
                                        const speed = side.SIDEBAR_SPEEDS.find(
                                            (one) => String(one) === value
                                        );
                                        if (speed) setEffect({ speed });
                                    }}
                                    options={side.SIDEBAR_SPEEDS.map((speed) => ({
                                        value: String(speed),
                                        label: t(SPEED_LABEL[speed])
                                    }))}
                                    aria-label={t("lineEditor.speedOn", {
                                        line: label.toLowerCase()
                                    })}
                                />
                            ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {effectHint(t, line.effect.kind)}.
                        </p>
                        {line.effect.kind === "scroll" ? (
                            <label className="flex items-center gap-2 text-xs">
                                {t("lineEditor.shows")}
                                <WholeNumberInput
                                    min={8}
                                    max={fits}
                                    value={line.effect.width}
                                    onValueChange={(width) => setEffect({ width })}
                                    className="h-8 w-20"
                                    aria-label={t("lineEditor.widthLabel", {
                                        line: label.toLowerCase()
                                    })}
                                />
                                {t("lineEditor.charactersAtATime")}
                            </label>
                        ) : null}
                        {colorNames.length > 0 ? (
                            <div
                                className={cn(
                                    "grid gap-3",
                                    colorNames.length > 1 && "sm:grid-cols-2"
                                )}
                            >
                                {colorNames.map((name, index) => (
                                    <ColorPicker
                                        key={name}
                                        label={name}
                                        value={
                                            line.effect.colors[index] ??
                                            EFFECT_DEFAULT_COLORS[line.effect.kind]?.[index] ??
                                            "#ffffff"
                                        }
                                        onChange={(hex) => {
                                            const colors = colorNames.map(
                                                (_, at) =>
                                                    (at === index ? hex : line.effect.colors[at]) ??
                                                    EFFECT_DEFAULT_COLORS[line.effect.kind]?.[at] ??
                                                    "#ffffff"
                                            );
                                            setEffect({
                                                colors: colors.map((one) => one.toLowerCase())
                                            });
                                        }}
                                    />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </fieldset>
            ) : null}
        </div>
    );
}
