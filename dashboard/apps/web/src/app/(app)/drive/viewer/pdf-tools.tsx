"use client";

/**
 * The annotation strip: which tool is in hand, and what it draws with. Only the
 * settings the tool in hand actually uses are shown, so the row stays a row.
 */

import { Button, Select, cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";
import type { EditorTool, ToolParams } from "./pdf-annotate";
import { DRAW_COLORS, HIGHLIGHT_COLORS, TOOLS } from "./pdf-annotate";

/** Point sizes: a unit, the same in every language. */
// i18n-ignore: a point size, the same in every language
const TEXT_SIZES = ["10", "12", "14", "18", "24"].map((value) => ({ value, label: `${value} pt` }));

const DRAW_THICKNESS: { value: string; label: NamespaceKey<"driveViewer"> }[] = [
    { value: "1", label: "pdfTools.widths.thin" },
    { value: "3", label: "pdfTools.widths.medium" },
    { value: "6", label: "pdfTools.widths.thick" },
    { value: "10", label: "pdfTools.widths.heavy" }
];

const HIGHLIGHT_THICKNESS: { value: string; label: NamespaceKey<"driveViewer"> }[] = [
    { value: "8", label: "pdfTools.widths.thin" },
    { value: "12", label: "pdfTools.widths.medium" },
    { value: "20", label: "pdfTools.widths.thick" }
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
    const t = useTranslations("driveViewer");
    return (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
            <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
                {TOOLS.map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        type="button"
                        title={t(label)}
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
                        {t(label)}
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
                        aria-label={t("pdfTools.textSize")}
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
                        options={DRAW_THICKNESS.map((one) => ({ value: one.value, label: t(one.label) }))}
                        aria-label={t("pdfTools.penWidth")}
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
                        options={HIGHLIGHT_THICKNESS.map((one) => ({ value: one.value, label: t(one.label) }))}
                        aria-label={t("pdfTools.highlighterWidth")}
                        className="h-7 w-[104px]"
                    />
                </>
            ) : null}

            {tool === "image" ? (
                <span className="text-xs text-muted-foreground">
                    {t("pdfTools.clickAPageToPlace")}
                </span>
            ) : null}

            {tool !== "none" ? (
                <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => onSelect("none")}
                >
                    {t("pdfTools.done")}
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
    colors: { value: string; label: NamespaceKey<"driveViewer"> }[];
    value: string;
    onChange: (color: string) => void;
}) {
    const t = useTranslations("driveViewer");
    return (
        <div className="flex items-center gap-1">
            {colors.map((color) => (
                <button
                    key={color.value}
                    type="button"
                    title={t(color.label)}
                    aria-label={t(color.label)}
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
