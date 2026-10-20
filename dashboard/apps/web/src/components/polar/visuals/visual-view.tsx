"use client";

/**
 * One view Polar drew inside an answer (`lib/polar/visuals.ts`), in a frame
 * that holds to the message column: its own width at most, never wider. A
 * table wider than the column scrolls sideways inside that one box; anything
 * taller than the frame's height is cut with a "Show all", so the page never
 * gets a second scroll inside the chat's. The frame carries the view as text
 * (copied as Markdown) and as CSV when it is a grid, and a view that fails to
 * draw is shown as that same text.
 */

import { downloadBytes } from "@/lib/download";
import { Input, cn, CopyIcon, useCopied } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { VisualChart } from "@/components/polar/visuals/visual-chart";
import { Check, ChevronDown, ChevronUp, Download } from "lucide-react";
import { VisualDiagram } from "@/components/polar/visuals/visual-diagram";
import { MessageAction, MessageResponse } from "@/components/polar/elements/message";
import { Component, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
    calculate,
    formatResult,
    startingValues,
    visualCsv,
    visualMarkdown,
    type CalculatorView,
    type PolarView,
    type PolarVisual
} from "@/lib/polar/visuals";

/** The tallest a view is drawn before it folds behind "Show all". */
export const VISUAL_FOLD_PX = 448;

type Kind = PolarView["kind"];
const KIND_KEYS = {
    table: "visual.kinds.table",
    chart: "visual.kinds.chart",
    stats: "visual.kinds.stats",
    steps: "visual.kinds.steps",
    comparison: "visual.kinds.comparison",
    diagram: "visual.kinds.diagram",
    calculator: "visual.kinds.calculator"
} as const satisfies Record<Kind, string>;

/** Shown while the model is still writing the view: its shape, not its half. */
export function VisualDrawing() {
    const t = useTranslations("polar");
    return (
        <div
            className="h-24 w-full min-w-0 animate-pulse rounded-lg border border-border bg-muted/50 motion-reduce:animate-none"
            role="status"
            aria-label={t("visual.drawing")}
        />
    );
}

export function PolarVisualView({ visual }: { visual: PolarVisual }) {
    const t = useTranslations("polar");
    const markdown = useMemo(() => visualMarkdown(visual), [visual]);
    const csv = useMemo(() => visualCsv(visual.view), [visual]);
    const name = visual.title?.trim() || t(KIND_KEYS[visual.view.kind]);
    const { copied, copy } = useCopied();
    const body = useRef<HTMLDivElement>(null);
    const [tall, setTall] = useState(false);
    const [open, setOpen] = useState(false);
    const regionId = useId();

    useEffect(() => {
        const element = body.current;
        if (!element) return;
        const measure = () => setTall(element.scrollHeight > VISUAL_FOLD_PX + 1);
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    return (
        <figure className="flex w-full min-w-0 max-w-full flex-col overflow-hidden rounded-lg border border-border bg-card">
            <figcaption className="flex min-w-0 items-center gap-2 border-b border-border py-1 pl-3 pr-1">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={name}>
                    {name}
                </span>
                {csv !== null ? (
                    <MessageAction
                        label={t("visual.download")}
                        onClick={() =>
                            downloadBytes(
                                new Blob([String.fromCharCode(0xfeff), csv], { type: "text/csv;charset=utf-8" }),
                                `${fileName(name)}.csv`
                            )
                        }
                    >
                        <Download />
                    </MessageAction>
                ) : null}
                <MessageAction
                    label={copied ? t("visual.copied") : t("visual.copy")}
                    onClick={() => void copy(markdown)}
                >
                    <CopyIcon copied={copied} />
                </MessageAction>
            </figcaption>
            <div
                id={regionId}
                ref={body}
                className={cn("relative min-w-0 p-3", tall && !open && "overflow-hidden")}
                style={tall && !open ? { maxHeight: VISUAL_FOLD_PX } : undefined}
            >
                <VisualBoundary fallback={<MessageResponse>{markdown}</MessageResponse>}>
                    <ViewBody view={visual.view} label={name} />
                </VisualBoundary>
                {tall && !open ? (
                    <div
                        className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent"
                        aria-hidden
                    />
                ) : null}
            </div>
            {tall ? (
                <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={regionId}
                    onClick={() => setOpen((value) => !value)}
                    className="flex items-center justify-center gap-1 border-t border-border py-1.5 text-xs text-muted-foreground hover:bg-card-hover hover:text-foreground"
                >
                    {open ? <ChevronUp className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
                    {open ? t("visual.collapse") : t("visual.expand")}
                </button>
            ) : null}
        </figure>
    );
}

/** A name a downloaded file can carry. */
function fileName(name: string): string {
    return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "polar";
}

/** Draws the view's text instead when the view itself throws. */
class VisualBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
    override state = { failed: false };
    static getDerivedStateFromError() {
        return { failed: true };
    }
    override componentDidCatch(error: unknown) {
        console.error("polar: a view could not be drawn", error);
    }
    override render() {
        return this.state.failed ? this.props.fallback : this.props.children;
    }
}

function ViewBody({ view, label }: { view: PolarView; label: string }) {
    switch (view.kind) {
        case "table":
            return (
                <Grid
                    label={label}
                    header={view.columns.map((column) => column.label)}
                    align={view.columns.map(
                        (column, index) =>
                            column.align ??
                            (view.rows.every((row) => row[index] === null || typeof row[index] === "number")
                                ? "end"
                                : "start")
                    )}
                    rows={view.rows}
                />
            );
        case "comparison":
            return <Comparison view={view} label={label} />;
        case "chart":
            return <VisualChart view={view} label={label} />;
        case "diagram":
            return <VisualDiagram view={view} label={label} />;
        case "stats":
            return (
                <ul className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))] gap-2">
                    {view.items.map((item, index) => (
                        <li key={index} className="flex min-w-0 flex-col gap-0.5 rounded-md bg-muted/50 px-3 py-2">
                            <span className="truncate text-xs text-muted-foreground" title={item.label}>
                                {item.label}
                            </span>
                            <span
                                className={cn(
                                    "truncate text-lg font-semibold tabular-nums text-foreground",
                                    item.tone === "good" && "text-success-ink",
                                    item.tone === "warning" && "text-warning-ink",
                                    item.tone === "bad" && "text-danger-ink"
                                )}
                                title={item.value}
                            >
                                {item.value}
                            </span>
                            {item.detail ? (
                                <span className="line-clamp-2 break-words text-xs text-foreground-subtle" title={item.detail}>
                                    {item.detail}
                                </span>
                            ) : null}
                        </li>
                    ))}
                </ul>
            );
        case "steps":
            return (
                <ol className="flex min-w-0 flex-col gap-3">
                    {view.items.map((item, index) => (
                        <li key={index} className="flex min-w-0 gap-3">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium tabular-nums text-primary">
                                {index + 1}
                            </span>
                            <div className="flex min-w-0 flex-col gap-0.5 pt-0.5">
                                <span className="break-words text-sm font-medium text-foreground">{item.title}</span>
                                {item.detail ? (
                                    <span className="break-words text-sm text-muted-foreground">{item.detail}</span>
                                ) : null}
                            </div>
                        </li>
                    ))}
                </ol>
            );
        case "calculator":
            return <Calculator view={view} />;
    }
}

function cellText(value: string | number | null): string {
    if (value === null) return "";
    return typeof value === "number" ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value) : value;
}

/** A table: the one box in a view that scrolls, and only sideways. */
function Grid({
    label,
    header,
    align,
    rows,
    highlight
}: {
    label: string;
    header: readonly string[];
    align: readonly ("start" | "end")[];
    rows: readonly (readonly (string | number | null)[])[];
    highlight?: number;
}) {
    const side = (index: number) => (align[index] === "end" ? "text-right" : "text-left");
    return (
        <div className="-mx-3 -my-3 min-w-0 overflow-x-auto overscroll-x-contain">
            <table className="w-full min-w-max border-collapse text-sm" aria-label={label}>
                <thead>
                    <tr className="border-b border-border">
                        {header.map((cell, index) => (
                            <th
                                key={index}
                                scope="col"
                                className={cn(
                                    "max-w-[16rem] px-3 py-2 align-bottom text-xs font-medium text-muted-foreground",
                                    side(index),
                                    highlight === index && "text-primary"
                                )}
                            >
                                {cell}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, at) => (
                        <tr key={at} className="border-b border-border last:border-b-0">
                            {header.map((_, index) => {
                                const Cell = index === 0 && highlight !== undefined ? "th" : "td";
                                return (
                                    <Cell
                                        key={index}
                                        scope={Cell === "th" ? "row" : undefined}
                                        className={cn(
                                            "max-w-[16rem] whitespace-normal break-words px-3 py-2 align-top text-foreground",
                                            side(index),
                                            typeof row[index] === "number" && "tabular-nums",
                                            Cell === "th" && "font-normal text-muted-foreground",
                                            highlight === index && "bg-primary/5"
                                        )}
                                    >
                                        {cellText(row[index] ?? null)}
                                    </Cell>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function Comparison({ view, label }: { view: Extract<PolarView, { kind: "comparison" }>; label: string }) {
    const t = useTranslations("polar");
    const pick = view.pick !== undefined ? view.pick + 1 : undefined;
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <Grid
                label={label}
                header={["", ...view.options]}
                align={["start", ...view.options.map(() => "start" as const)]}
                rows={view.rows.map((row) => [row.label, ...row.values])}
                highlight={pick ?? -1}
            />
            {view.pick !== undefined ? (
                <p className="mt-3 flex min-w-0 items-center gap-1.5 text-xs text-primary">
                    <Check className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate" title={view.options[view.pick]}>
                        {t("visual.recommended")}: {view.options[view.pick]}
                    </span>
                </p>
            ) : null}
        </div>
    );
}

/** One field's typed text as a number, or why it is not one it takes. */
function readField(field: CalculatorView["fields"][number], typed: string): number | "empty" | "invalid" {
    const trimmed = typed.trim().replace(",", ".");
    if (trimmed === "") return "empty";
    const value = Number(trimmed);
    if (!Number.isFinite(value)) return "invalid";
    if (field.min !== undefined && value < field.min) return "invalid";
    if (field.max !== undefined && value > field.max) return "invalid";
    return value;
}

function Calculator({ view }: { view: CalculatorView }) {
    const t = useTranslations("polar");
    const [typed, setTyped] = useState<Record<string, string>>(() =>
        Object.fromEntries(Object.entries(startingValues(view)).map(([id, value]) => [id, String(value)]))
    );
    const read = view.fields.map((field) => readField(field, typed[field.id] ?? ""));
    const whole = read.every((value) => typeof value === "number");
    const values = Object.fromEntries(view.fields.map((field, index) => [field.id, read[index] as number]));
    const baseId = useId();
    return (
        <div className="flex min-w-0 flex-col gap-3">
            <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] gap-3">
                {view.fields.map((field, index) => {
                    const id = `${baseId}-${field.id}`;
                    const state = read[index];
                    const range =
                        field.min !== undefined && field.max !== undefined
                            ? t("visual.between", { min: field.min, max: field.max })
                            : field.min !== undefined
                              ? t("visual.atLeast", { min: field.min })
                              : field.max !== undefined
                                ? t("visual.atMost", { max: field.max })
                                : null;
                    return (
                        <div key={field.id} className="flex min-w-0 flex-col gap-1">
                            <label htmlFor={id} className="truncate text-xs text-muted-foreground" title={field.label}>
                                {field.label}
                                {field.unit ? ` (${field.unit})` : ""}
                            </label>
                            <Input
                                id={id}
                                type="number"
                                inputMode="decimal"
                                value={typed[field.id] ?? ""}
                                min={field.min}
                                max={field.max}
                                step={field.step ?? "any"}
                                aria-invalid={state === "invalid" || undefined}
                                aria-describedby={state === "invalid" && range ? `${id}-range` : undefined}
                                onChange={(event) => setTyped((current) => ({ ...current, [field.id]: event.target.value }))}
                            />
                            {state === "invalid" && range ? (
                                <span id={`${id}-range`} className="text-xs text-danger-ink">
                                    {range}
                                </span>
                            ) : null}
                        </div>
                    );
                })}
            </div>
            <dl className="flex min-w-0 flex-col gap-1 border-t border-border pt-3">
                {view.outputs.map((output, index) => (
                    <div key={index} className="flex min-w-0 items-baseline justify-between gap-3">
                        <dt className="min-w-0 truncate text-sm text-muted-foreground" title={output.label}>
                            {output.label}
                        </dt>
                        <dd className="shrink-0 text-base font-semibold tabular-nums text-foreground" aria-live="polite">
                            {whole ? formatResult(calculate(output.formula, values), output.decimals ?? 2) : "-"}
                            {output.unit ? ` ${output.unit}` : ""}
                        </dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}
