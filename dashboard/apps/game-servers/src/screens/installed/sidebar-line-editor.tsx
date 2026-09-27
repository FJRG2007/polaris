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
import { FieldNote } from "./minecraft-announce";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import { FormattedTextField } from "../../components/formatted-text-field";
import { EFFECT_DEFAULT_COLORS } from "../../lib/minecraft/sidebar-effects";
import { Button, ColorPicker, Input, Select, SegmentedControl, cn } from "@polaris/ui";
import * as side from "../../lib/minecraft/sidebar";

/** What each effect is called, and what it does, in a few words. */
export const EFFECT_LABEL: Readonly<
    Record<side.SidebarEffectKind, { name: string; hint: string }>
> = {
    none: { name: "None", hint: "Stays as written" },
    rainbow: { name: "Rainbow", hint: "Colours running along the line" },
    wave: { name: "Wave", hint: "Two colours flowing across it" },
    shine: { name: "Shine", hint: "A glint sweeping over it, its own colours kept" },
    typewriter: { name: "Typewriter", hint: "Typed out letter by letter" },
    blink: { name: "Blink", hint: "Dims and lights up again" },
    scroll: { name: "Scroll", hint: "Slides a longer text through a window" }
};

const SPEED_LABEL: Readonly<Record<side.SidebarSpeed, string>> = {
    2000: "Slow",
    1000: "Normal",
    500: "Fast"
};

/** Which of an effect's colours can be chosen, and what each is called. */
const EFFECT_COLORS: Readonly<Partial<Record<side.SidebarEffectKind, readonly string[]>>> = {
    wave: ["From", "To"],
    shine: ["Glint"],
    blink: ["Dimmed to"]
};

/** What a line does beyond its first text, in one line, or null when nothing. */
export function lineSummary(line: side.SidebarLine): string | null {
    const parts: string[] = [];
    if (line.frames.length > 1) parts.push(`${line.frames.length} texts, ${line.every} s each`);
    if (line.effect.kind !== "none") parts.push(EFFECT_LABEL[line.effect.kind].name);
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
    disabled
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
}) {
    const [open, setOpen] = useState(false);
    const summary = lineSummary(line);
    const max = side.textMax(line, fits);
    const setFrame = (index: number, value: string) =>
        onChange({
            ...line,
            frames: line.frames.map((frame, at) => (at === index ? value : frame))
        });
    const setEffect = (patch: Partial<side.SidebarLine["effect"]>) =>
        onChange({ ...line, effect: { ...line.effect, ...patch } });
    const colorNames = EFFECT_COLORS[line.effect.kind] ?? [];

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
                        aria-label={`Animate ${label.toLowerCase()}: take turns between texts, or an effect`}
                        title="Take turns between texts, or add an effect"
                    >
                        <Sparkles className="size-3.5" />
                        Animate
                    </Button>
                }
                footnote={
                    <span className="flex flex-col">
                        <FieldNote
                            text={line.frames[0] ?? ""}
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
                <div className="flex flex-col gap-3 rounded-md border border-border p-3">
                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-medium">Take turns with</span>
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
                                            label={`${label}, text ${index + 1}`}
                                            placeholder="Leave empty for a gap"
                                            inserts={inserts}
                                            footnote={
                                                <FieldNote
                                                    text={frame}
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
                                        aria-label={`Remove text ${index + 1} of ${label.toLowerCase()}`}
                                        title={`Remove text ${index + 1}`}
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
                                <Plus className="size-4" /> Add a text
                            </Button>
                            {line.frames.length > 1 ? (
                                <label className="flex items-center gap-2 text-xs">
                                    Each for
                                    <Input
                                        type="number"
                                        inputMode="numeric"
                                        min={side.SIDEBAR_EVERY_MIN}
                                        max={side.SIDEBAR_EVERY_MAX}
                                        value={line.every}
                                        disabled={disabled}
                                        onChange={(event) => {
                                            const seconds = Math.round(Number(event.target.value));
                                            if (!Number.isFinite(seconds)) return;
                                            onChange({
                                                ...line,
                                                every: Math.min(
                                                    side.SIDEBAR_EVERY_MAX,
                                                    Math.max(side.SIDEBAR_EVERY_MIN, seconds)
                                                )
                                            });
                                        }}
                                        className="h-8 w-20"
                                        aria-label={`Seconds each text of ${label.toLowerCase()} shows`}
                                    />
                                    seconds
                                </label>
                            ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Lines that change every as many seconds change together, so a heading
                            and the list under it stay matched.
                        </p>
                    </div>

                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-medium">Effect</span>
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
                                    label: EFFECT_LABEL[kind].name
                                }))}
                                disabled={disabled}
                                className="w-40"
                                aria-label={`Effect on ${label.toLowerCase()}`}
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
                                        label: SPEED_LABEL[speed]
                                    }))}
                                    aria-label={`Speed of the effect on ${label.toLowerCase()}`}
                                />
                            ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {EFFECT_LABEL[line.effect.kind].hint}.
                        </p>
                        {line.effect.kind === "scroll" ? (
                            <label className="flex items-center gap-2 text-xs">
                                Shows
                                <Input
                                    type="number"
                                    inputMode="numeric"
                                    min={8}
                                    max={fits}
                                    value={line.effect.width}
                                    disabled={disabled}
                                    onChange={(event) => {
                                        const width = Math.round(Number(event.target.value));
                                        if (Number.isFinite(width))
                                            setEffect({
                                                width: Math.min(fits, Math.max(8, width))
                                            });
                                    }}
                                    className="h-8 w-20"
                                    aria-label={`Characters the scrolling ${label.toLowerCase()} shows at once`}
                                />
                                characters at a time
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
                </div>
            ) : null}
        </div>
    );
}
