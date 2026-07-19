"use client";

/**
 * In-dashboard file viewer. Opens a file in a modal and renders it inline by type
 * - images natively, audio/video through a Polaris-themed Plyr, PDFs via pdf.js,
 * and spreadsheets/CSV via SheetJS. Anything else offers a download. The heavy
 * viewer libraries are dynamically imported inside effects so they never run
 * during SSR and only load when a file of that type is actually opened. Bytes are
 * streamed from the drive route with an inline disposition (Range-enabled, so
 * media scrubbing and large PDFs work) and stay same-origin, so no external
 * assets are ever fetched.
 */

import "plyr/dist/plyr.css";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Download, FileQuestion, Loader2 } from "lucide-react";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@polaris/ui";
import { extensionOf } from "./file-categories";

export interface ViewerTarget {
    connectionId: string;
    path: string;
    name: string;
}

type ViewerKind = "image" | "video" | "audio" | "pdf" | "sheet" | "text" | "none";

const IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif", "ico"]);
const VIDEO = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const AUDIO = new Set(["mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "opus"]);
const SHEET = new Set(["xlsx", "xls", "csv", "ods", "tsv"]);
const TEXT = new Set(["txt", "md", "markdown", "log", "json", "xml", "yaml", "yml", "ini", "conf", "csv"]);

/** Which viewer, if any, can render a file by its extension. */
export function viewerKind(name: string): ViewerKind {
    const ext = extensionOf(name);
    if (IMAGE.has(ext)) return "image";
    if (VIDEO.has(ext)) return "video";
    if (AUDIO.has(ext)) return "audio";
    if (ext === "pdf") return "pdf";
    if (SHEET.has(ext)) return "sheet";
    if (TEXT.has(ext)) return "text";
    return "none";
}

/** Whether a file can be opened in the viewer at all (drives the click behavior). */
export function isViewable(name: string): boolean {
    return viewerKind(name) !== "none";
}

function byteUrl(target: ViewerTarget, inline: boolean): string {
    const query = new URLSearchParams({ c: target.connectionId, p: target.path });
    if (inline) query.set("disposition", "inline");
    return `/api/drive/download?${query.toString()}`;
}

export function FileViewer({
    target,
    onOpenChange
}: {
    target: ViewerTarget | null;
    onOpenChange: (open: boolean) => void;
}) {
    const kind = target ? viewerKind(target.name) : "none";
    const inlineSrc = target ? byteUrl(target, true) : "";

    return (
        <Dialog open={target !== null} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[90vh] w-full max-w-5xl flex-col gap-0 overflow-hidden p-0">
                <DialogHeader className="flex flex-row items-center justify-between gap-3 px-4 py-3">
                    <DialogTitle className="min-w-0 truncate text-sm">{target?.name}</DialogTitle>
                    {target ? (
                        <Button asChild size="sm" variant="secondary" className="mr-8 shrink-0">
                            <a href={byteUrl(target, false)} download={target.name}>
                                <Download className="size-4" />
                                Download
                            </a>
                        </Button>
                    ) : null}
                </DialogHeader>
                <div className="min-h-0 flex-1 overflow-auto bg-surface/40">
                    {target ? (
                        kind === "image" ? (
                            <div className="flex items-center justify-center p-4">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={inlineSrc} alt={target.name} className="max-h-[75vh] max-w-full object-contain" />
                            </div>
                        ) : kind === "video" || kind === "audio" ? (
                            <MediaView src={inlineSrc} kind={kind} />
                        ) : kind === "pdf" ? (
                            <PdfView src={inlineSrc} />
                        ) : kind === "sheet" ? (
                            <SheetView src={inlineSrc} />
                        ) : kind === "text" ? (
                            <TextView src={inlineSrc} />
                        ) : (
                            <Unsupported />
                        )
                    ) : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

function Unsupported() {
    return (
        <div className="flex flex-col items-center gap-2 p-12 text-center text-sm text-muted-foreground">
            <FileQuestion className="size-8" />
            <p>No inline preview for this file type. Use Download to open it.</p>
        </div>
    );
}

function Loading() {
    return (
        <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading preview...
        </div>
    );
}

/** Polyfill-free Plyr wrapper, themed to the Polaris primary color. */
function MediaView({ src, kind }: { src: string; kind: "video" | "audio" }) {
    const ref = useRef<HTMLMediaElement | null>(null);

    useEffect(() => {
        let player: { destroy(): void } | null = null;
        let active = true;
        void import("plyr").then((module) => {
            if (!active || !ref.current) return;
            const Plyr = module.default;
            player = new Plyr(ref.current, {
                controls: ["play", "progress", "current-time", "mute", "volume", "settings", "fullscreen"]
            });
        });
        return () => {
            active = false;
            player?.destroy();
        };
    }, [src]);

    const style = { "--plyr-color-main": "hsl(var(--primary))" } as CSSProperties;

    return (
        <div className="p-4" style={style}>
            {kind === "video" ? (
                <video
                    ref={(element) => {
                        ref.current = element;
                    }}
                    controls
                    playsInline
                    src={src}
                    className="w-full"
                />
            ) : (
                <audio
                    ref={(element) => {
                        ref.current = element;
                    }}
                    controls
                    src={src}
                    className="w-full"
                />
            )}
        </div>
    );
}

/** Render every page of a PDF to a canvas, top to bottom. */
function PdfView({ src }: { src: string }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

    useEffect(() => {
        let active = true;
        const container = containerRef.current;
        if (container) container.innerHTML = "";
        setStatus("loading");

        void (async () => {
            try {
                const pdfjs = await import("pdfjs-dist");
                pdfjs.GlobalWorkerOptions.workerSrc = new URL(
                    "pdfjs-dist/build/pdf.worker.min.mjs",
                    import.meta.url
                ).toString();
                const doc = await pdfjs.getDocument({ url: src, withCredentials: true }).promise;
                if (!active) return;
                for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
                    const page = await doc.getPage(pageNumber);
                    if (!active || !containerRef.current) return;
                    const viewport = page.getViewport({ scale: 1.4 });
                    const canvas = document.createElement("canvas");
                    canvas.width = viewport.width;
                    canvas.height = viewport.height;
                    canvas.className = "mx-auto mb-4 max-w-full rounded shadow";
                    const context = canvas.getContext("2d");
                    if (!context) continue;
                    containerRef.current.appendChild(canvas);
                    await page.render({ canvasContext: context, viewport }).promise;
                }
                if (active) setStatus("ready");
            } catch {
                if (active) setStatus("error");
            }
        })();

        return () => {
            active = false;
        };
    }, [src]);

    return (
        <div className="p-4">
            {status === "loading" ? <Loading /> : null}
            {status === "error" ? (
                <p className="p-8 text-center text-sm text-danger">This PDF could not be rendered.</p>
            ) : null}
            <div ref={containerRef} />
        </div>
    );
}

/** Parse a spreadsheet with SheetJS and render each sheet as an HTML table. */
function SheetView({ src }: { src: string }) {
    const [sheets, setSheets] = useState<{ name: string; html: string }[] | null>(null);
    const [active, setActive] = useState(0);
    const [error, setError] = useState(false);

    useEffect(() => {
        let alive = true;
        setSheets(null);
        setError(false);
        void (async () => {
            try {
                const [XLSX, response] = await Promise.all([import("xlsx"), fetch(src)]);
                const buffer = await response.arrayBuffer();
                if (!alive) return;
                const workbook = XLSX.read(buffer, { type: "array" });
                const parsed = workbook.SheetNames.map((name) => ({
                    name,
                    html: XLSX.utils.sheet_to_html(workbook.Sheets[name]!)
                }));
                setSheets(parsed);
            } catch {
                if (alive) setError(true);
            }
        })();
        return () => {
            alive = false;
        };
    }, [src]);

    if (error) return <p className="p-8 text-center text-sm text-danger">This spreadsheet could not be read.</p>;
    if (!sheets) return <Loading />;

    return (
        <div className="flex flex-col">
            <style>{`
                .sheet-preview table { border-collapse: collapse; }
                .sheet-preview td, .sheet-preview th {
                    border: 1px solid hsl(var(--border));
                    padding: 4px 8px;
                    white-space: nowrap;
                }
                .sheet-preview tr:first-child td { font-weight: 600; }
            `}</style>
            {sheets.length > 1 ? (
                <div className="flex flex-wrap gap-1 px-4 pt-3">
                    {sheets.map((sheet, index) => (
                        <button
                            key={sheet.name}
                            type="button"
                            onClick={() => setActive(index)}
                            className={
                                index === active
                                    ? "rounded-md bg-muted px-3 py-1 text-xs font-medium"
                                    : "rounded-md px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
                            }
                        >
                            {sheet.name}
                        </button>
                    ))}
                </div>
            ) : null}
            <div
                className="sheet-preview overflow-auto p-4 text-sm"
                dangerouslySetInnerHTML={{ __html: sheets[active]?.html ?? "" }}
            />
        </div>
    );
}

/** Fetch and show a small text file verbatim. */
function TextView({ src }: { src: string }) {
    const [text, setText] = useState<string | null>(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        let alive = true;
        setText(null);
        setError(false);
        fetch(src)
            .then((response) => response.text())
            .then((body) => alive && setText(body.slice(0, 500_000)))
            .catch(() => alive && setError(true));
        return () => {
            alive = false;
        };
    }, [src]);

    if (error) return <p className="p-8 text-center text-sm text-danger">This file could not be read.</p>;
    if (text === null) return <Loading />;
    return <pre className="overflow-auto p-4 text-xs leading-relaxed">{text}</pre>;
}
