"use client";

/**
 * The bar above the pages: where you are in the document, how big it is drawn,
 * how the pages are laid out, and the actions that leave the viewer (printing,
 * full screen). The save actions are passed in, because who may write the file
 * is the viewer's business rather than the toolbar's.
 */

import { ScrollMode, SpreadMode } from "@pdfslick/react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";
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

const SCROLL_MODES: { value: number; label: NamespaceKey<"driveViewer"> }[] = [
    { value: ScrollMode.VERTICAL, label: "pdf.scroll.vertical" },
    { value: ScrollMode.HORIZONTAL, label: "pdf.scroll.horizontal" },
    { value: ScrollMode.WRAPPED, label: "pdf.scroll.wrapped" },
    { value: ScrollMode.PAGE, label: "pdf.scroll.page" }
];

const SPREAD_MODES: { value: number; label: NamespaceKey<"driveViewer"> }[] = [
    { value: SpreadMode.NONE, label: "pdf.spread.none" },
    { value: SpreadMode.ODD, label: "pdf.spread.odd" },
    { value: SpreadMode.EVEN, label: "pdf.spread.even" }
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
    const t = useTranslations("driveViewer");
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

    const zoom = zoomChoices(t, scale, scaleValue);

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
                aria-label={t("pdf.pagesAndOutline")}
                title={t("pdf.pagesAndOutline")}
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
                    aria-label={t("pdf.previousPage")}
                    title={t("pdf.previousPage")}
                    onClick={() => pdfSlick?.gotoPage(pageNumber - 1)}
                >
                    <ChevronUp />
                </Button>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={pageNumber >= numPages}
                    aria-label={t("pdf.nextPage")}
                    title={t("pdf.nextPage")}
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
                    aria-label={t("pdf.pageNumber")}
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
                    aria-label={t("pdf.zoomOut")}
                    title={t("pdf.zoomOut")}
                    onClick={() => pdfSlick?.decreaseScale()}
                >
                    <ZoomOut />
                </Button>
                <Select
                    value={zoom.value}
                    onValueChange={setZoom}
                    options={zoom.options}
                    aria-label={t("pdf.zoom")}
                    className="h-7 w-[124px]"
                />
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("pdf.zoomIn")}
                    title={t("pdf.zoomIn")}
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
                    aria-label={t("pdf.findInDocument")}
                    title={t("pdf.findInDocument")}
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
                            aria-label={t("pdf.viewOptions")}
                            title={t("pdf.viewOptions")}
                        >
                            <MoreHorizontal />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => pdfSlick?.setRotation(rotation + 90)}>
                            <RotateCw />
                            {t("pdf.rotate")}
                        </DropdownMenuItem>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <Rows3 />
                                {t("pdf.scrolling")}
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
                                        {t(mode.label)}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <Columns2 />
                                {t("pdf.pageLayout")}
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
                                        {t(mode.label)}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => pdfSlick?.requestPresentationMode()}>
                            <Expand />
                            {t("pdf.fullScreen")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            disabled={!pdfSlick?.supportsPrinting}
                            onSelect={() => pdfSlick?.triggerPrinting()}
                        >
                            <Printer />
                            {t("pdf.print")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                {actions}
            </div>
        </div>
    );
}
