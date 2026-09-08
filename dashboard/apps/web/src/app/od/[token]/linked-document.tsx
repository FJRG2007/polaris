"use client";

/**
 * The document itself, for somebody who arrived on a link.
 *
 * The same five editors the app uses, loaded on demand rather than all at once:
 * a spreadsheet engine and a drawing canvas are megabytes each, and a link to a
 * document should not cost somebody the other four.
 *
 * It is the real editor rather than a rendering of the content, which is what
 * makes an editing link worth having: what they type goes through the same
 * shared-document machinery everybody else's typing does, so a person on a link
 * and a person in the app are in the same room, seeing each other's changes.
 *
 * What they do NOT get is the chrome. No rail, no rename, no share, no bin -
 * only the document and its name. Every one of those is a decision about the
 * document rather than a change to it, and none of them travel down a URL.
 */

import dynamic from "next/dynamic";
import * as core from "@polaris/core";
import { Loader2 } from "lucide-react";

/** What every editor takes. The same four whichever kind this is. */
interface Opened {
    documentId: string;
    content: number[] | null;
    editable: boolean;
}

function Waiting() {
    return (
        <div className="flex min-h-[60vh] items-center justify-center">
            <Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            <span className="sr-only">Opening the document</span>
        </div>
    );
}

// `ssr: false` on every one of them, and not for convenience: these mount canvas
// and worker-backed engines that have no meaning on a server, and rendering them
// there is a crash rather than a slow page.
const EDITORS: Record<core.OfficeKind, React.ComponentType<Opened>> = {
    doc: dynamic(() => import("@/app/(app)/office/d/[id]/doc-editor").then((m) => m.DocEditor), {
        ssr: false,
        loading: Waiting
    }),
    sheet: dynamic(
        () => import("@/app/(app)/office/s/[id]/sheet-editor").then((m) => m.SheetEditor),
        { ssr: false, loading: Waiting }
    ),
    slides: dynamic(
        () => import("@/app/(app)/office/p/[id]/slides-editor").then((m) => m.SlidesEditor),
        { ssr: false, loading: Waiting }
    ),
    diagram: dynamic(
        () => import("@/app/(app)/office/g/[id]/diagram-editor").then((m) => m.DiagramEditor),
        { ssr: false, loading: Waiting }
    ),
    comparison: dynamic(
        () => import("@/app/(app)/office/c/[id]/comparison-editor").then((m) => m.ComparisonEditor),
        { ssr: false, loading: Waiting }
    )
};

export function LinkedDocument({
    documentId,
    kind,
    title,
    content,
    editable
}: {
    documentId: string;
    kind: core.OfficeKind;
    title: string;
    content: number[] | null;
    editable: boolean;
}) {
    const Editor = EDITORS[kind];
    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
            <header className="flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 flex-1 truncate text-[1.0625rem] font-semibold tracking-tight">
                    {title}
                </h1>
                {/* Said plainly, because the difference decides whether somebody
                    starts typing. A viewer who thinks they are editing writes a
                    paragraph into nothing. */}
                <span className="shrink-0 text-[12px] text-muted-foreground">
                    {editable ? "You can edit this" : "You can read this"}
                </span>
            </header>
            <Editor documentId={documentId} content={content} editable={editable} />
        </div>
    );
}
