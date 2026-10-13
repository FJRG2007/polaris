"use client";

/**
 * A document's first page, sheet or slide, drawn small for its tile on the
 * Office home - see `lib/office/preview` for why it is words rather than an
 * image.
 *
 * Asked for only when the tile comes near the screen, the way Drive's grid asks
 * for a picture, so a long shelf scrolled straight through costs nothing. The
 * answer is kept for the tab's life under the time the document last changed,
 * so coming back to the home draws every tile at once, and an edited document
 * asks again. Until it arrives, or when there is nothing to draw, the tile shows
 * the kind's mark.
 */

import { cn } from "@polaris/ui";
import type * as core from "@polaris/core";
import { useEffect, useRef, useState } from "react";
import { officePreviewSchema, type OfficePreview } from "@/lib/office/preview";

/** How far below the screen a tile starts asking, so it is drawn on arrival. */
const LOOKAHEAD = "300px";

/** What this tab has been told, by document and version. */
const known = new Map<string, OfficePreview>();

export function DocumentPreview({
    id,
    kind,
    version,
    fallback
}: {
    readonly id: string;
    readonly kind: core.OfficeKind;
    /** When it last changed: a new version is a new question. */
    readonly version: string;
    /** What is drawn while there is no preview - the kind's mark. */
    readonly fallback: React.ReactNode;
}) {
    const key = `${id}@${version}`;
    const holder = useRef<HTMLDivElement>(null);
    const [preview, setPreview] = useState<OfficePreview | null>(() => known.get(key) ?? null);
    const [near, setNear] = useState(false);

    useEffect(() => {
        setPreview(known.get(key) ?? null);
    }, [key]);

    useEffect(() => {
        const node = holder.current;
        if (!node || known.has(key)) return;
        if (typeof IntersectionObserver !== "function") {
            setNear(true);
            return;
        }
        const watch = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setNear(true);
                    watch.disconnect();
                }
            },
            { rootMargin: LOOKAHEAD }
        );
        watch.observe(node);
        return () => watch.disconnect();
    }, [key]);

    useEffect(() => {
        if (!near || known.has(key) || kind === "diagram") return;
        const controller = new AbortController();
        fetch(`/api/office/${encodeURIComponent(id)}/preview?v=${encodeURIComponent(version)}`, {
            signal: controller.signal
        })
            .then((response) => (response.ok ? response.json() : null))
            .then((body) => {
                const parsed = officePreviewSchema.safeParse(body);
                if (!parsed.success) return;
                known.set(key, parsed.data);
                setPreview(parsed.data);
            })
            .catch(() => {
                // The tile keeps the kind's mark; the next visit asks again.
            });
        return () => controller.abort();
    }, [near, key, id, kind, version]);

    return (
        <div ref={holder} aria-hidden className="size-full overflow-hidden">
            {preview && hasWords(preview) ? <Drawn preview={preview} /> : fallback}
        </div>
    );
}

function hasWords(preview: OfficePreview): boolean {
    if (preview.kind === "doc") return preview.blocks.length > 0;
    if (preview.kind === "sheet" || preview.kind === "comparison") return preview.rows.length > 0;
    if (preview.kind === "slides") return preview.lines.length > 0;
    return false;
}

function Drawn({ preview }: { preview: OfficePreview }) {
    if (preview.kind === "doc") {
        return (
            <div className="mx-auto mt-3 h-full w-[86%] rounded-t-sm bg-surface px-3 pt-3 shadow-sm ring-1 ring-border">
                {preview.blocks.map((block, at) => (
                    <p
                        key={at}
                        className={cn(
                            "truncate leading-[1.5] text-foreground-subtle",
                            block.kind.startsWith("h")
                                ? "mb-0.5 text-[9px] font-semibold text-foreground"
                                : "text-[7px]",
                            (block.kind === "li" || block.kind === "oli") && "pl-2",
                            block.kind === "quote" && "border-l border-border pl-1.5 italic"
                        )}
                    >
                        {block.kind === "li" ? "- " : null}
                        {block.text}
                    </p>
                ))}
            </div>
        );
    }
    if (preview.kind === "sheet" || preview.kind === "comparison") {
        return (
            <table className="w-full table-fixed border-collapse bg-surface text-[7px] leading-tight text-foreground-subtle">
                <tbody>
                    {preview.rows.map((row, at) => (
                        <tr key={at}>
                            {row.map((cell, column) => (
                                <td
                                    key={column}
                                    className={cn(
                                        "truncate border border-border px-1 py-0.5",
                                        preview.kind === "comparison" &&
                                            (at === 0 || column === 0) &&
                                            "font-semibold text-foreground"
                                    )}
                                >
                                    {cell}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        );
    }
    if (preview.kind === "slides") {
        const [heading, ...rest] = preview.lines;
        return (
            <div className="grid size-full place-items-center p-3">
                <div className="flex aspect-video w-full min-w-0 flex-col justify-center gap-1 rounded-sm bg-surface px-3 shadow-sm ring-1 ring-border">
                    <p
                        className="truncate text-[10px] font-semibold text-foreground"
                        title={heading}
                    >
                        {heading}
                    </p>
                    {rest.map((line, at) => (
                        <p key={at} className="truncate text-[7px] text-foreground-subtle">
                            {line}
                        </p>
                    ))}
                </div>
            </div>
        );
    }
    return null;
}
