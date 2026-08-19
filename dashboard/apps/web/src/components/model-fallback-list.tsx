"use client";

/**
 * The order to try models in when the first one will not serve the run.
 *
 * Ordered by dragging, because the order IS the setting and a list of numbered
 * dropdowns would make somebody encode a sequence they can already see. Every
 * row is also movable from the keyboard - the whole point is a preference
 * somebody expresses quickly, and a control only a mouse can reach is one a
 * screen reader cannot express at all.
 *
 * Dragging is implemented with the browser's own drag events rather than a
 * library: the list is short by construction, the interaction is one axis, and
 * the alternative is a dependency for a hundred lines.
 */

import { useEffect, useMemo, useState } from "react";
import { Button } from "@polaris/ui";
import { ChevronDown, ChevronUp, GripVertical, Plus, X } from "lucide-react";
import { ModelPicker, formatContext, type PickerModel } from "@/components/model-picker";

export function ModelFallbackList({
    value,
    onChange,
    loadModels
}: {
    /** Null is "inherit". An empty list is a deliberate "do not fall back", and
     *  the two have to stay distinguishable all the way to the column. */
    value: string[] | null;
    onChange: (next: string[] | null) => void;
    loadModels: () => Promise<PickerModel[]>;
}) {
    const [adding, setAdding] = useState(false);
    // Read so a row can say what the model holds. The picker caches the same
    // call for the session, so this is the same one request either way, and a
    // slug the catalogue does not carry renders as itself - which is exactly
    // what a hand-typed specifier is.
    const [catalog, setCatalog] = useState<PickerModel[]>([]);
    useEffect(() => {
        let live = true;
        void loadModels()
            .then((rows) => {
                if (live) setCatalog(rows);
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [loadModels]);
    const known = useMemo(() => new Map(catalog.map((row) => [row.slug, row])), [catalog]);
    const list = value ?? [];

    const move = (from: number, to: number) => {
        if (to < 0 || to >= list.length || from === to) return;
        const next = [...list];
        const [row] = next.splice(from, 1);
        if (row === undefined) return;
        next.splice(to, 0, row);
        onChange(next);
    };

    const add = (slug: string | null) => {
        setAdding(false);
        if (!slug || list.includes(slug)) return;
        onChange([...list, slug]);
    };

    if (value === null) {
        return (
            <div className="flex items-center gap-2">
                <p className="text-muted-foreground flex-1 text-xs">Inherited.</p>
                <Button type="button" variant="secondary" size="sm" onClick={() => onChange([])}>
                    Set here
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-2">
            {list.map((slug, index) => (
                <Row
                    key={slug}
                    slug={slug}
                    model={known.get(slug) ?? null}
                    index={index}
                    total={list.length}
                    onMove={move}
                    onRemove={() => onChange(list.filter((entry) => entry !== slug))}
                />
            ))}

            {list.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                    Nothing to fall back to. A run refused by its provider stops there.
                </p>
            ) : null}

            {adding ? (
                <ModelPicker value={null} onChange={add} load={loadModels} inheritLabel={null} placeholder="Add a model" />
            ) : (
                <div className="flex items-center gap-2">
                    <Button type="button" variant="secondary" size="sm" onClick={() => setAdding(true)}>
                        <Plus className="size-4 shrink-0" />
                        Add a model
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
                        Inherit instead
                    </Button>
                </div>
            )}
        </div>
    );
}

function Row({
    slug,
    model,
    index,
    total,
    onMove,
    onRemove
}: {
    slug: string;
    model: PickerModel | null;
    index: number;
    total: number;
    onMove: (from: number, to: number) => void;
    onRemove: () => void;
}) {
    const [over, setOver] = useState(false);

    return (
        <div
            draggable
            onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))}
            onDragOver={(event) => {
                // Without this the drop never fires: the default handling of a
                // dragover is to refuse the drop.
                event.preventDefault();
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
                event.preventDefault();
                setOver(false);
                const from = Number(event.dataTransfer.getData("text/plain"));
                if (Number.isInteger(from)) onMove(from, index);
            }}
            className={`border-border/60 bg-background flex items-center gap-2 rounded-md border px-2 py-1.5 ${
                over ? "border-primary" : ""
            }`}
        >
            <GripVertical className="text-muted-foreground size-4 shrink-0 cursor-grab" aria-hidden />
            <span className="text-muted-foreground w-5 shrink-0 text-xs tabular-nums">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate text-sm" title={slug}>
                {model?.name ?? slug}
            </span>
            {model ? (
                <span className="text-muted-foreground shrink-0 text-xs">{formatContext(model.contextTokens)}</span>
            ) : null}
            <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={index === 0}
                onClick={() => onMove(index, index - 1)}
                aria-label={`Move ${slug} earlier`}
                title="Move earlier"
            >
                <ChevronUp className="size-4 shrink-0" />
            </Button>
            <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={index === total - 1}
                onClick={() => onMove(index, index + 1)}
                aria-label={`Move ${slug} later`}
                title="Move later"
            >
                <ChevronDown className="size-4 shrink-0" />
            </Button>
            <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onRemove}
                aria-label={`Remove ${slug} from the fallback list`}
                title="Remove"
            >
                <X className="size-4 shrink-0" />
            </Button>
        </div>
    );
}
