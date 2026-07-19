"use client";

/**
 * In-dashboard file viewer. Opens a file in a modal and renders it inline by type
 * - images natively, audio/video through a Polaris-themed Plyr, PDFs in the
 * browser's native viewer (an inline iframe: crisp, selectable text, zoom), and
 * spreadsheets/CSV via SheetJS. Anything else offers a download. The heavy viewer
 * libraries are dynamically imported inside effects so they never run during SSR
 * and only load when a file of that type is actually opened. Bytes are streamed
 * from the drive route with an inline disposition (Range-enabled, so media
 * scrubbing works) and stay same-origin, so no external assets are ever fetched.
 * A properties sidebar and Share/Download actions sit alongside the preview.
 */

import "plyr/dist/plyr.css";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Download, FileQuestion, Loader2, Share2 } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@polaris/ui";
import { extensionOf } from "./file-categories";

export interface ViewerTarget {
    connectionId: string;
    path: string;
    name: string;
    /** Byte size (serialized) and modified time, for the properties sidebar. */
    size?: string;
    modifiedAt?: string;
}

type ViewerKind = "image" | "video" | "audio" | "pdf" | "sheet" | "doc" | "text" | "none";

const IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif", "ico"]);
const VIDEO = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const AUDIO = new Set(["mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "opus"]);
const SHEET = new Set(["xlsx", "xls", "csv", "ods", "tsv"]);
const DOC = new Set(["docx"]);
const TEXT = new Set(["txt", "md", "markdown", "log", "json", "xml", "yaml", "yml", "ini", "conf", "csv"]);

/** Which viewer, if any, can render a file by its extension. */
export function viewerKind(name: string): ViewerKind {
    const ext = extensionOf(name);
    if (IMAGE.has(ext)) return "image";
    if (VIDEO.has(ext)) return "video";
    if (AUDIO.has(ext)) return "audio";
    if (ext === "pdf") return "pdf";
    if (SHEET.has(ext)) return "sheet";
    if (DOC.has(ext)) return "doc";
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
    onOpenChange,
    onShare
}: {
    target: ViewerTarget | null;
    onOpenChange: (open: boolean) => void;
    onShare?: (target: ViewerTarget) => void;
}) {
    const kind = target ? viewerKind(target.name) : "none";
    const inlineSrc = target ? byteUrl(target, true) : "";
    const extension = target ? extensionOf(target.name) : "";

    return (
        <Dialog open={target !== null} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[90vh] w-full max-w-6xl flex-col gap-0 overflow-hidden p-0">
                <DialogHeader className="flex flex-row items-center justify-between gap-3 px-4 py-3">
                    <DialogTitle className="min-w-0 truncate text-sm">{target?.name}</DialogTitle>
                    {target ? (
                        <div className="mr-8 flex shrink-0 items-center gap-2">
                            {onShare ? (
                                <Button size="sm" variant="ghost" onClick={() => onShare(target)}>
                                    <Share2 className="size-4" />
                                    Share
                                </Button>
                            ) : null}
                            <Button asChild size="sm" variant="secondary">
                                <a href={byteUrl(target, false)} download={target.name}>
                                    <Download className="size-4" />
                                    Download
                                </a>
                            </Button>
                        </div>
                    ) : null}
                </DialogHeader>
                <div className="flex min-h-0 flex-1">
                    <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-surface/40">
                        {target ? (
                            kind === "image" ? (
                                <div className="flex items-center justify-center p-4">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                        src={inlineSrc}
                                        alt={target.name}
                                        className="max-h-[80vh] max-w-full object-contain"
                                    />
                                </div>
                            ) : kind === "video" || kind === "audio" ? (
                                <MediaView src={inlineSrc} kind={kind} />
                            ) : kind === "pdf" ? (
                                <PdfView src={inlineSrc} />
                            ) : kind === "sheet" ? (
                                <SheetView src={inlineSrc} />
                            ) : kind === "doc" ? (
                                <DocView src={inlineSrc} />
                            ) : kind === "text" ? (
                                <TextView src={inlineSrc} />
                            ) : (
                                <Unsupported />
                            )
                        ) : null}
                    </div>
                    {target ? (
                        <aside className="hidden w-56 shrink-0 flex-col gap-2 border-l border-border p-4 text-sm md:flex">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Properties
                            </p>
                            <div className="flex justify-between gap-2">
                                <span className="text-muted-foreground">Type</span>
                                <span>{extension ? `${extension.toUpperCase()} file` : "File"}</span>
                            </div>
                            {target.size !== undefined ? (
                                <div className="flex justify-between gap-2">
                                    <span className="text-muted-foreground">Size</span>
                                    <span>{formatBytes(BigInt(target.size))}</span>
                                </div>
                            ) : null}
                            {target.modifiedAt ? (
                                <div className="flex flex-col gap-0.5">
                                    <span className="text-muted-foreground">Modified</span>
                                    <span>{new Date(target.modifiedAt).toLocaleString()}</span>
                                </div>
                            ) : null}
                            <div className="flex flex-col gap-0.5">
                                <span className="text-muted-foreground">Location</span>
                                <span className="break-all">/{target.path.split("/").slice(0, -1).join("/")}</span>
                            </div>
                        </aside>
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

/**
 * Show a PDF in the browser's native viewer via an inline iframe. This renders
 * crisply and keeps selectable, copyable text, zoom, and print - which a
 * hand-rolled canvas render does not - with no library weight. The bytes are
 * served same-origin with an inline disposition.
 */
function PdfView({ src }: { src: string }) {
    return <iframe title="PDF preview" src={src} className="h-[80vh] w-full border-0" />;
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

/** Render a .docx to styled HTML with mammoth (dynamically imported). */
function DocView({ src }: { src: string }) {
    const [html, setHtml] = useState<string | null>(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        let alive = true;
        setHtml(null);
        setError(false);
        void (async () => {
            try {
                const [mammoth, response] = await Promise.all([import("mammoth"), fetch(src)]);
                const arrayBuffer = await response.arrayBuffer();
                if (!alive) return;
                const result = await mammoth.convertToHtml({ arrayBuffer });
                if (alive) setHtml(result.value);
            } catch {
                if (alive) setError(true);
            }
        })();
        return () => {
            alive = false;
        };
    }, [src]);

    if (error) return <p className="p-8 text-center text-sm text-danger">This document could not be rendered.</p>;
    if (html === null) return <Loading />;
    return (
        <div className="mx-auto max-w-3xl p-6">
            <style>{`
                .doc-preview { line-height: 1.6; }
                .doc-preview h1 { font-size: 1.5rem; font-weight: 600; margin: 1rem 0 0.5rem; }
                .doc-preview h2 { font-size: 1.25rem; font-weight: 600; margin: 1rem 0 0.5rem; }
                .doc-preview p { margin: 0.5rem 0; }
                .doc-preview ul, .doc-preview ol { margin: 0.5rem 0 0.5rem 1.5rem; }
                .doc-preview table { border-collapse: collapse; margin: 0.5rem 0; }
                .doc-preview td, .doc-preview th { border: 1px solid hsl(var(--border)); padding: 4px 8px; }
                .doc-preview a { color: hsl(var(--primary)); text-decoration: underline; }
            `}</style>
            <div className="doc-preview text-sm" dangerouslySetInnerHTML={{ __html: html }} />
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
