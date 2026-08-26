"use client";

/**
 * The annotation strip: which tool is in hand, and what it draws with. Only the
 * settings the tool in hand actually uses are shown, so the row stays a row.
 */

import { Button, Select, cn } from "@polaris/ui";
import type { EditorTool, ToolParams } from "./pdf-annotate";
import { DRAW_COLORS, HIGHLIGHT_COLORS, TOOLS } from "./pdf-annotate";

const TEXT_SIZES = [
    { value: "10", label: "10 pt" },
    { value: "12", label: "12 pt" },
    { value: "14", label: "14 pt" },
    { value: "18", label: "18 pt" },
    { value: "24", label: "24 pt" }
];

const DRAW_THICKNESS = [
    { value: "1", label: "Thin" },
    { value: "3", label: "Medium" },
    { value: "6", label: "Thick" },
    { value: "10", label: "Heavy" }
];

const HIGHLIGHT_THICKNESS = [
    { value: "8", label: "Thin" },
    { value: "12", label: "Medium" },
    { value: "20", label: "Thick" }
];

export function PdfTools({
    tool,
    onSelect,
    params,
    onParams,
    disabled
}: {
    tool: EditorTool;
    onSelect: (tool: EditorTool) => void;
    params: ToolParams;
    onParams: (patch: Partial<ToolParams>) => void;
    disabled: boolean;
}) {
    return (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
            <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
                {TOOLS.map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        type="button"
                        title={label}
                        disabled={disabled}
                        aria-pressed={tool === id}
                        onClick={() => onSelect(id)}
                        className={cn(
                            "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors hover:bg-card-hover disabled:opacity-50",
                            tool === id
                                ? "bg-muted font-medium text-foreground"
                                : "text-muted-foreground"
                        )}
                    >
                        <Icon className="size-4 shrink-0" />
                        {label}
                    </button>
                ))}
            </div>

            {tool === "text" ? (
                <>
                    <Swatches
                        colors={DRAW_COLORS}
                        value={params.textColor}
                        onChange={(textColor) => onParams({ textColor })}
                    />
                    <Select
                        value={String(params.textSize)}
                        onValueChange={(value) => onParams({ textSize: Number(value) })}
                        options={TEXT_SIZES}
                        aria-label="Text size"
                        className="h-7 w-[92px]"
                    />
                </>
            ) : null}

            {tool === "draw" ? (
                <>
                    <Swatches
                        colors={DRAW_COLORS}
                        value={params.drawColor}
                        onChange={(drawColor) => onParams({ drawColor })}
                    />
                    <Select
                        value={String(params.drawThickness)}
                        onValueChange={(value) => onParams({ drawThickness: Number(value) })}
                        options={DRAW_THICKNESS}
                        aria-label="Pen width"
                        className="h-7 w-[104px]"
                    />
                </>
            ) : null}

            {tool === "highlight" ? (
                <>
                    <Swatches
                        colors={HIGHLIGHT_COLORS}
                        value={params.highlightColor}
                        onChange={(highlightColor) => onParams({ highlightColor })}
                    />
                    <Select
                        value={String(params.highlightThickness)}
                        onValueChange={(value) => onParams({ highlightThickness: Number(value) })}
                        options={HIGHLIGHT_THICKNESS}
                        aria-label="Highlighter width"
                        className="h-7 w-[104px]"
                    />
                </>
            ) : null}

            {tool === "image" ? (
                <span className="text-xs text-muted-foreground">
                    Click a page to place a picture.
                </span>
            ) : null}

            {tool !== "none" ? (
                <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => onSelect("none")}
                >
                    Done
                </Button>
            ) : null}
        </div>
    );
}

function Swatches({
    colors,
    value,
    onChange
}: {
    colors: { value: string; label: string }[];
    value: string;
    onChange: (color: string) => void;
}) {
    return (
        <div className="flex items-center gap-1">
            {colors.map((color) => (
                <button
                    key={color.value}
                    type="button"
                    title={color.label}
                    aria-label={color.label}
                    aria-pressed={color.value === value}
                    onClick={() => onChange(color.value)}
                    style={{ background: color.value }}
                    className={cn(
                        "size-5 rounded-full border transition-transform",
                        color.value === value
                            ? "border-foreground scale-110"
                            : "border-border hover:scale-105"
                    )}
                />
            ))}
        </div>
    );
}
