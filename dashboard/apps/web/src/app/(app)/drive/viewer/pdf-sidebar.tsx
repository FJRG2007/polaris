"use client";

/**
 * The panel beside the pages: thumbnails to jump by, the document's own outline
 * when it has one, and the files attached to it.
 *
 * It is mounted for as long as the document is, collapsed rather than removed.
 * pdf.js is handed the thumbnail container once, when the viewer is built, so a
 * panel that unmounted would take the thumbnails with it and never get them
 * back.
 */

import { useState } from "react";
import { Paperclip } from "lucide-react";
import { PDFSlickThumbnails } from "@pdfslick/react";
import { Button, SegmentedControl, cn } from "@polaris/ui";
import type { PDFSlick, TPDFDocumentOutline, TUsePDFSlickStore } from "@pdfslick/react";

type SidebarTab = "pages" | "outline" | "files";

export function PdfSidebar({
    open,
    pdfSlick,
    thumbsRef,
    usePDFSlickStore
}: {
    open: boolean;
    pdfSlick: PDFSlick | null;
    thumbsRef: (instance: HTMLElement | null) => void;
    usePDFSlickStore: TUsePDFSlickStore;
}) {
    const [tab, setTab] = useState<SidebarTab>("pages");
    const outline = usePDFSlickStore((state) => state.documentOutline);
    const attachments = usePDFSlickStore((state) => state.attachments);
    const pageNumber = usePDFSlickStore((state) => state.pageNumber);

    const tabs = [
        { value: "pages" as const, label: "Pages" },
        { value: "outline" as const, label: "Outline", disabled: !outline?.length },
        { value: "files" as const, label: "Files", disabled: attachments.size === 0 }
    ];
    // A tab whose content the document does not carry falls back to the pages,
    // rather than showing an empty panel for something that will never fill.
    const active = tabs.find((option) => option.value === tab)?.disabled ? "pages" : tab;

    return (
        <aside
            aria-hidden={!open}
            className={cn(
                "shrink-0 overflow-hidden border-r border-border bg-surface transition-[width] duration-200",
                open ? "w-[168px]" : "w-0"
            )}
        >
            <div className={cn("flex h-full w-[168px] flex-col", !open && "invisible")}>
                <div className="border-b border-border p-2">
                    <SegmentedControl
                        size="sm"
                        aria-label="Sidebar view"
                        value={active}
                        onValueChange={setTab}
                        options={tabs}
                    />
                </div>
                <div className={cn("relative min-h-0 flex-1", active !== "pages" && "hidden")}>
                    <PDFSlickThumbnails
                        thumbsRef={thumbsRef}
                        usePDFSlickStore={usePDFSlickStore}
                        className="p-2"
                    >
                        {({ pageNumber: page, width, height, src, pageLabel, loaded }) => (
                            <button
                                type="button"
                                onClick={() => pdfSlick?.gotoPage(page)}
                                aria-current={page === pageNumber}
                                className="group flex w-full flex-col items-center gap-1 py-1.5"
                            >
                                <span
                                    style={{ width, height }}
                                    className={cn(
                                        "block overflow-hidden rounded-sm border bg-white transition-colors",
                                        page === pageNumber
                                            ? "border-primary ring-1 ring-primary"
                                            : "border-border group-hover:border-border-strong"
                                    )}
                                >
                                    {loaded && src ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={src} alt="" width={width} height={height} />
                                    ) : null}
                                </span>
                                <span
                                    className={cn(
                                        "text-[0.6875rem] tabular-nums",
                                        page === pageNumber
                                            ? "text-foreground"
                                            : "text-muted-foreground"
                                    )}
                                >
                                    {pageLabel ?? page}
                                </span>
                            </button>
                        )}
                    </PDFSlickThumbnails>
                </div>
                {active === "outline" ? (
                    <div className="min-h-0 flex-1 overflow-auto p-2">
                        <OutlineTree items={outline ?? []} pdfSlick={pdfSlick} depth={0} />
                    </div>
                ) : null}
                {active === "files" ? (
                    <div className="min-h-0 flex-1 overflow-auto p-2">
                        {[...attachments.values()].map((attachment) => (
                            <Button
                                key={attachment.filename}
                                size="sm"
                                variant="ghost"
                                className="w-full justify-start"
                                title={attachment.filename}
                                onClick={() =>
                                    pdfSlick?.openOrDownloadData(
                                        attachment.content,
                                        attachment.filename
                                    )
                                }
                            >
                                <Paperclip className="size-4 shrink-0" />
                                <span className="truncate" title={attachment.filename}>
                                    {attachment.filename}
                                </span>
                            </Button>
                        ))}
                    </div>
                ) : null}
            </div>
        </aside>
    );
}

/**
 * The document's own table of contents. An entry either names a place in the
 * document or an address outside it; the second is somebody else's link inside
 * a file we did not write, so it opens with no referrer and no relationship to
 * this tab.
 */
function OutlineTree({
    items,
    pdfSlick,
    depth
}: {
    items: TPDFDocumentOutline;
    pdfSlick: PDFSlick | null;
    depth: number;
}) {
    return (
        <ul className={cn(depth > 0 && "ml-2 border-l border-border pl-2")}>
            {items.map((item, index) => (
                <li key={`${item.title}-${index}`}>
                    {item.url ? (
                        <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                            className="block rounded px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-card-hover hover:text-foreground"
                        >
                            {item.title}
                        </a>
                    ) : (
                        <button
                            type="button"
                            onClick={() => pdfSlick?.linkService.goToDestination(item.dest)}
                            className="block w-full rounded px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-card-hover hover:text-foreground"
                        >
                            {item.title}
                        </button>
                    )}
                    {item.items.length > 0 ? (
                        <OutlineTree items={item.items} pdfSlick={pdfSlick} depth={depth + 1} />
                    ) : null}
                </li>
            ))}
        </ul>
    );
}
