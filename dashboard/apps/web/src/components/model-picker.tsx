"use client";

/**
 * Choosing the model a run happens on.
 *
 * This used to be a plain list of one model per connected provider, so somebody
 * with a Groq key could pick `gpt-oss-120b` and nothing else, with nothing on the
 * screen to say what it holds. The list now comes from the downloaded catalogue,
 * and each row carries the two facts that decide whether a choice was a good one:
 * how much the model can hold, and what it costs to fill it.
 *
 * What it deliberately does not show is whether the account can afford to run it.
 * That is the plan's per-minute allowance, no provider publishes it, and a badge
 * implying otherwise would be the same false confidence the old list gave.
 *
 * The field still accepts free text. The catalogue can lag a model released this
 * morning, and a picker that refused to let somebody type it would make Polaris
 * the reason they cannot use it.
 */

import Fuse from "fuse.js";
import { Button, Input } from "@polaris/ui";
import { Check, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** One model as a row renders it. Mirrors `CatalogModel`, minus what no screen
 *  reads, so the payload crossing the wire stays small. */
export interface PickerModel {
    slug: string;
    provider: string;
    name: string;
    contextTokens: number;
    reasoning: boolean;
    costInput: number | null;
}

/** Loaded once per session: the catalogue changes daily at most, and a dialog
 *  reopened while deciding should not go back for it. */
let cached: PickerModel[] | null = null;

/** Compact token counts, because "131072" is not a size anybody reads. */
export function formatContext(tokens: number): string {
    if (tokens <= 0) return "unknown";
    if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
    return `${Math.round(tokens / 1000)}K`;
}

/** Price per million input tokens, as the catalogue publishes it. */
function formatCost(cost: number | null): string | null {
    if (cost === null || !Number.isFinite(cost)) return null;
    if (cost === 0) return "free";
    return `$${cost < 1 ? cost.toFixed(2) : cost.toFixed(2).replace(/\.00$/, "")}/M in`;
}

export interface ModelPickerProps {
    /** The chosen slug, or null for whatever the caller calls inheriting. */
    value: string | null;
    onChange: (slug: string | null) => void;
    /** The catalogue, narrowed to the providers this deployment has keys for. */
    load: () => Promise<PickerModel[]>;
    /** Shown as the empty choice. Null removes it, for a field that must be set. */
    inheritLabel?: string | null;
    placeholder?: string;
    disabled?: boolean;
}

export function ModelPicker({
    value,
    onChange,
    load,
    inheritLabel = "Inherit",
    placeholder = "Search models",
    disabled = false
}: ModelPickerProps) {
    const [models, setModels] = useState<PickerModel[]>(cached ?? []);
    const [loading, setLoading] = useState(cached === null);
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(false);
    const box = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (cached !== null) return;
        let live = true;
        void load()
            .then((rows) => {
                cached = rows;
                if (live) setModels(rows);
            })
            .catch(() => undefined)
            .finally(() => {
                if (live) setLoading(false);
            });
        return () => {
            live = false;
        };
    }, [load]);

    // Closing on an outside press rather than on blur: blur fires as the pointer
    // goes down on a row, which would close the list before the click landed.
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            if (!box.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        return () => document.removeEventListener("pointerdown", onPointerDown);
    }, [open]);

    const fuse = useMemo(
        () =>
            new Fuse(models, {
                keys: ["name", "slug", "provider"],
                threshold: 0.35,
                ignoreLocation: true
            }),
        [models]
    );

    const results = useMemo(() => {
        const trimmed = query.trim();
        if (!trimmed) return models;
        return fuse.search(trimmed).map((hit) => hit.item);
    }, [fuse, models, query]);

    const chosen = useMemo(
        () => models.find((model) => model.slug === value) ?? null,
        [models, value]
    );

    const pick = useCallback(
        (slug: string | null) => {
            onChange(slug);
            setQuery("");
            setOpen(false);
        },
        [onChange]
    );

    // Free text the catalogue does not carry is a real choice, not a mistake: a
    // model released today, or a provider Polaris does not index. Offered only
    // when it looks like a specifier, since a bare word is not one.
    const typed = query.trim();
    const offerTyped = typed.includes("/") && !models.some((model) => model.slug === typed);

    return (
        <div className="relative" ref={box}>
            <button
                type="button"
                disabled={disabled}
                onClick={() => setOpen((was) => !was)}
                className="border-input bg-background ring-offset-background focus-visible:ring-ring flex h-9 w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
                <span className="min-w-0 truncate text-left">
                    {chosen ? chosen.name : (value ?? inheritLabel ?? placeholder)}
                </span>
                {chosen ? (
                    <span className="text-muted-foreground shrink-0 text-xs">
                        {formatContext(chosen.contextTokens)}
                    </span>
                ) : null}
            </button>

            {/* bg-card, not bg-popover: there is no popover colour in the preset,
                so that class paints nothing and the list comes out see-through
                over whatever is under it. */}
            {open ? (
                <div className="bg-card absolute z-50 mt-1 w-full rounded-md border border-border shadow-lg">
                    <div className="flex items-center gap-2 border-b px-3 py-2">
                        <Search className="text-muted-foreground size-4 shrink-0" />
                        <Input
                            autoFocus
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={placeholder}
                            className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                        />
                        {loading ? (
                            <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
                        ) : null}
                    </div>

                    <div className="max-h-72 overflow-y-auto p-1">
                        {inheritLabel !== null ? (
                            <Row
                                label={inheritLabel}
                                selected={value === null}
                                onSelect={() => pick(null)}
                            />
                        ) : null}

                        {offerTyped ? (
                            <Row
                                label={typed}
                                detail="Use as typed"
                                selected={value === typed}
                                onSelect={() => pick(typed)}
                            />
                        ) : null}

                        {results.map((model) => (
                            <Row
                                key={model.slug}
                                label={model.name}
                                detail={[
                                    model.provider,
                                    `${formatContext(model.contextTokens)} context`,
                                    formatCost(model.costInput)
                                ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                selected={value === model.slug}
                                onSelect={() => pick(model.slug)}
                            />
                        ))}

                        {!loading && results.length === 0 && !offerTyped ? (
                            <p className="text-muted-foreground px-3 py-6 text-center text-sm">
                                {models.length === 0
                                    ? "No models yet. Connect a provider, or refresh the catalogue under Admin > Agents."
                                    : "Nothing matches. Type a full specifier to use it anyway."}
                            </p>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function Row({
    label,
    detail,
    selected,
    onSelect
}: {
    label: string;
    detail?: string;
    selected: boolean;
    onSelect: () => void;
}) {
    return (
        <Button
            type="button"
            variant="ghost"
            onClick={onSelect}
            className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left font-normal"
        >
            <Check className={`size-4 shrink-0 ${selected ? "opacity-100" : "opacity-0"}`} />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm" title={label}>
                    {label}
                </span>
                {detail ? (
                    <span className="text-muted-foreground block truncate text-xs" title={detail}>
                        {detail}
                    </span>
                ) : null}
            </span>
        </Button>
    );
}
