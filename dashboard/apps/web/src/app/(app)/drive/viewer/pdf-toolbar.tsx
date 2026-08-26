"use client";

/**
 * The bar above the pages: where you are in the document, how big it is drawn,
 * how the pages are laid out, and the actions that leave the viewer (printing,
 * full screen). The save actions are passed in, because who may write the file
 * is the viewer's business rather than the toolbar's.
 */

import { ScrollMode, SpreadMode } from "@pdfslick/react";
import { useEffect, useState, type ReactNode } from "react";
import type { PDFSlick, TUsePDFSlickStore } from "@pdfslick/react";
import { ZOOM_PRESETS, pageFromInput, zoomChoices } from "./pdf-controls";
import {
    ChevronDown,
    ChevronUp,
    Check,
    Columns2,
    Expand,
    MoreHorizontal,
    PanelLeft,
    Printer,
    RotateCw,
    Rows3,
    Search,
    ZoomIn,
    ZoomOut
} from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    Input,
    Select,
    cn
} from "@polaris/ui";

const SCROLL_MODES = [
    { value: ScrollMode.VERTICAL, label: "Vertical" },
    { value: ScrollMode.HORIZONTAL, label: "Horizontal" },
    { value: ScrollMode.WRAPPED, label: "Wrapped" },
    { value: ScrollMode.PAGE, label: "One page at a time" }
];

const SPREAD_MODES = [
    { value: SpreadMode.NONE, label: "Single page" },
    { value: SpreadMode.ODD, label: "Odd pages left" },
    { value: SpreadMode.EVEN, label: "Even pages left" }
];

export function PdfToolbar({
    pdfSlick,
    usePDFSlickStore,
    sidebarOpen,
    onSidebarToggle,
    searchOpen,
    onSearchToggle,
    actions
}: {
    pdfSlick: PDFSlick | null;
    usePDFSlickStore: TUsePDFSlickStore;
    sidebarOpen: boolean;
    onSidebarToggle: () => void;
    searchOpen: boolean;
    onSearchToggle: () => void;
    /** The save actions, when the reader is allowed to write the file back. */
    actions?: ReactNode;
}) {
    const pageNumber = usePDFSlickStore((state) => state.pageNumber);
    const numPages = usePDFSlickStore((state) => state.numPages);
    const scale = usePDFSlickStore((state) => state.scale);
    const scaleValue = usePDFSlickStore((state) => state.scaleValue);
    const rotation = usePDFSlickStore((state) => state.pagesRotation);
    const scrollMode = usePDFSlickStore((state) => state.scrollMode);
    const spreadMode = usePDFSlickStore((state) => state.spreadMode);
    // Typing a page is a draft until it names one, so the box holds what was
    // typed and falls back to where the reader actually is.
    const [pageDraft, setPageDraft] = useState("");

    useEffect(() => {
        setPageDraft(String(pageNumber));
    }, [pageNumber]);

    const zoom = zoomChoices(scale, scaleValue);

    function setZoom(value: string) {
        if (!pdfSlick) return;
        if (ZOOM_PRESETS.some((preset) => preset.value === value))
            pdfSlick.currentScaleValue = value;
        else pdfSlick.currentScale = Number(value);
    }

    function goToDraft() {
        const page = pageFromInput(pageDraft, numPages);
        if (page === null) setPageDraft(String(pageNumber));
        else pdfSlick?.gotoPage(page);
    }

    return (
        <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
            <Button
                size="icon-sm"
                variant="ghost"
                aria-pressed={sidebarOpen}
                aria-label="Pages and outline"
                title="Pages and outline"
                onClick={onSidebarToggle}
                className={cn(sidebarOpen && "bg-muted text-foreground")}
            >
                <PanelLeft />
            </Button>

            <div className="flex items-center">
                <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={pageNumber <= 1}
                    aria-label="Previous page"
                    title="Previous page"
                    onClick={() => pdfSlick?.gotoPage(pageNumber - 1)}
                >
                    <ChevronUp />
                </Button>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={pageNumber >= numPages}
                    aria-label="Next page"
                    title="Next page"
                    onClick={() => pdfSlick?.gotoPage(pageNumber + 1)}
                >
                    <ChevronDown />
                </Button>
            </div>

            <div className="flex items-center gap-1.5">
                <Input
                    value={pageDraft}
                    onChange={(event) => setPageDraft(event.target.value)}
                    onBlur={goToDraft}
                    onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        goToDraft();
                    }}
                    aria-label="Page number"
                    inputMode="numeric"
                    className="h-7 w-12 text-center tabular-nums"
                />
                <span className="text-xs tabular-nums text-muted-foreground">
                    of {numPages || "-"}
                </span>
            </div>

            <div className="ml-1 flex items-center gap-1">
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Zoom out"
                    title="Zoom out"
                    onClick={() => pdfSlick?.decreaseScale()}
                >
                    <ZoomOut />
                </Button>
                <Select
                    value={zoom.value}
                    onValueChange={setZoom}
                    options={zoom.options}
                    aria-label="Zoom"
                    className="h-7 w-[124px]"
                />
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Zoom in"
                    title="Zoom in"
                    onClick={() => pdfSlick?.increaseScale()}
                >
                    <ZoomIn />
                </Button>
            </div>

            <div className="ml-auto flex items-center gap-1">
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-pressed={searchOpen}
                    aria-label="Find in document"
                    title="Find in document"
                    onClick={onSearchToggle}
                    className={cn(searchOpen && "bg-muted text-foreground")}
                >
                    <Search />
                </Button>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="View options"
                            title="View options"
                        >
                            <MoreHorizontal />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => pdfSlick?.setRotation(rotation + 90)}>
                            <RotateCw />
                            Rotate
                        </DropdownMenuItem>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <Rows3 />
                                Scrolling
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {SCROLL_MODES.map((mode) => (
                                    <DropdownMenuItem
                                        key={mode.value}
                                        onSelect={() => pdfSlick?.setScrollMode(mode.value)}
                                    >
                                        <Check
                                            className={cn(mode.value !== scrollMode && "invisible")}
                                        />
                                        {mode.label}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <Columns2 />
                                Page layout
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {SPREAD_MODES.map((mode) => (
                                    <DropdownMenuItem
                                        key={mode.value}
                                        onSelect={() => pdfSlick?.setSpreadMode(mode.value)}
                                    >
                                        <Check
                                            className={cn(mode.value !== spreadMode && "invisible")}
                                        />
                                        {mode.label}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => pdfSlick?.requestPresentationMode()}>
                            <Expand />
                            Full screen
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            disabled={!pdfSlick?.supportsPrinting}
                            onSelect={() => pdfSlick?.triggerPrinting()}
                        >
                            <Printer />
                            Print
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                {actions}
            </div>
        </div>
    );
}
