"use client";

/**
 * In-dashboard file viewer. Opens a file in a modal and renders it inline by type
 * - images natively, audio/video through a Polaris-themed Plyr, PDFs in the
 * browser's native viewer (an inline iframe: crisp, selectable text, zoom), and
 * spreadsheets/CSV via SheetJS. Anything else opens as editable plain text
 * (Notepad-style), with binary or oversized files shown read-only. The heavy viewer
 * libraries are dynamically imported inside effects so they never run during SSR
 * and only load when a file of that type is actually opened. Bytes are streamed
 * from the drive route with an inline disposition (Range-enabled, so media
 * scrubbing works) and stay same-origin, so no external assets are ever fetched.
 * A properties sidebar and Share/Download actions sit alongside the preview.
 */

import "plyr/dist/plyr.css";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Download, Loader2, Pencil, Share2 } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, cn } from "@polaris/ui";
import { extensionOf } from "./file-categories";

export interface ViewerTarget {
    connectionId: string;
    path: string;
    name: string;
    /** Byte size (serialized) and modified time, for the properties sidebar. */
    size?: string;
    modifiedAt?: string;
}

type ViewerKind =
    | "image"
    | "video"
    | "audio"
    | "pdf"
    | "sheet"
    | "doc"
    | "markdown"
    | "text"
    | "none";

const IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif", "ico"]);
const VIDEO = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const AUDIO = new Set(["mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "opus"]);
const SHEET = new Set(["xlsx", "xls", "csv", "ods", "tsv"]);
const DOC = new Set(["docx"]);
const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd"]);

/**
 * Which viewer renders a file by its extension. Anything without a richer viewer
 * falls back to "text" - the Notepad-style editor opens it as plain text.
 */
export function viewerKind(name: string): ViewerKind {
    const ext = extensionOf(name);
    if (IMAGE.has(ext)) return "image";
    if (VIDEO.has(ext)) return "video";
    if (AUDIO.has(ext)) return "audio";
    if (ext === "pdf") return "pdf";
    if (SHEET.has(ext)) return "sheet";
    if (DOC.has(ext)) return "doc";
    if (MARKDOWN.has(ext)) return "markdown";
    return "text";
}

/** Whether a file can be opened in the viewer (drives the click behavior). */
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
                            ) : kind === "markdown" ? (
                                <MarkdownView src={inlineSrc} target={target} />
                            ) : (
                                <PlainTextEditor src={inlineSrc} target={target} />
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
                                <span>
                                    {extension ? `${extension.toUpperCase()} file` : "File"}
                                </span>
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
                                <span className="break-all">
                                    /{target.path.split("/").slice(0, -1).join("/")}
                                </span>
                            </div>
                        </aside>
                    ) : null}
                </div>
            </DialogContent>
        </Dialog>
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
                controls: [
                    "play",
                    "progress",
                    "current-time",
                    "mute",
                    "volume",
                    "settings",
                    "fullscreen"
                ]
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

    if (error)
        return (
            <p className="p-8 text-center text-sm text-danger">
                This spreadsheet could not be read.
            </p>
        );
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

    if (error)
        return (
            <p className="p-8 text-center text-sm text-danger">
                This document could not be rendered.
            </p>
        );
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

const TEXT_LIMIT = 500_000;

/**
 * Save file text back through the upload route (PUT). Returns a human-readable
 * error message, or null on success. Shared by the Markdown and plain-text
 * editors so both handle write access, locks, and failures identically.
 */
async function saveTextFile(target: ViewerTarget, body: string): Promise<string | null> {
    const parent = target.path.split("/").slice(0, -1).join("/");
    const query = new URLSearchParams({ c: target.connectionId, name: target.name });
    if (parent) query.set("p", parent);
    try {
        const response = await fetch(`/api/drive/upload?${query.toString()}`, {
            method: "PUT",
            body
        });
        if (response.ok) return null;
        if (response.status === 403) return "Could not save - you may not have write access here.";
        if (response.status === 423) return "This file is locked.";
        return "Could not save this file.";
    } catch {
        return "Could not save this file.";
    }
}

/**
 * Read at most `limit` bytes from a response body and report whether more
 * remained. The stream is cancelled once the cap is hit, so opening a huge file
 * as text never pulls the whole thing into memory.
 */
async function readCapped(
    response: Response,
    limit: number
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    const reader = response.body?.getReader();
    if (!reader) {
        const all = new Uint8Array(await response.arrayBuffer());
        return { bytes: all.subarray(0, limit), truncated: all.byteLength > limit };
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (received < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
            chunks.push(value);
            received += value.byteLength;
        }
    }
    // Stopped at the cap: one more read tells us whether the file continues.
    let truncated = received > limit;
    if (!truncated && received >= limit) {
        const next = await reader.read();
        truncated = Boolean(!next.done && next.value?.byteLength);
    }
    await reader.cancel().catch(() => undefined);
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { bytes: merged.subarray(0, limit), truncated };
}

/** A NUL byte in the leading bytes is a reliable "this is not text" signal. */
function looksBinary(bytes: Uint8Array): boolean {
    const span = Math.min(bytes.length, 8192);
    for (let index = 0; index < span; index++) {
        if (bytes[index] === 0) return true;
    }
    return false;
}

/**
 * Notepad-style viewer/editor for any file without a richer viewer. Reads the
 * first 500 KB, shows it verbatim, and edits save back through the upload route
 * (guarded by write access). Binary content or a truncated read stays read-only
 * so a save can never corrupt or truncate the file.
 */
function PlainTextEditor({ src, target }: { src: string; target: ViewerTarget }) {
    const [text, setText] = useState<string | null>(null);
    const [error, setError] = useState(false);
    const [binary, setBinary] = useState(false);
    const [truncated, setTruncated] = useState(false);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        setText(null);
        setError(false);
        setEditing(false);
        setSaveError(null);
        void (async () => {
            try {
                const response = await fetch(src);
                if (!response.ok) throw new Error("read failed");
                const { bytes, truncated: cut } = await readCapped(response, TEXT_LIMIT);
                if (!alive) return;
                setBinary(looksBinary(bytes));
                setTruncated(cut);
                setText(new TextDecoder().decode(bytes));
            } catch {
                if (alive) setError(true);
            }
        })();
        return () => {
            alive = false;
        };
    }, [src]);

    async function save() {
        if (draft === text) {
            setEditing(false);
            return;
        }
        setSaving(true);
        setSaveError(null);
        const message = await saveTextFile(target, draft);
        if (message) {
            setSaveError(message);
            setSaving(false);
            return;
        }
        setText(draft);
        setEditing(false);
        setSaving(false);
    }

    if (error)
        return <p className="p-8 text-center text-sm text-danger">This file could not be read.</p>;
    if (text === null) return <Loading />;

    const editable = !binary && !truncated;
    const label = binary ? "Binary file" : truncated ? "Preview only (large file)" : "Plain text";

    return (
        <div className="flex max-h-[80vh] flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                {editing ? (
                    <>
                        <span className="text-xs font-medium text-muted-foreground">Editing</span>
                        <div className="ml-auto flex items-center gap-2">
                            {saveError ? (
                                <span className="text-xs text-danger">{saveError}</span>
                            ) : null}
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                    setEditing(false);
                                    setSaveError(null);
                                }}
                                disabled={saving}
                            >
                                Cancel
                            </Button>
                            <Button size="sm" onClick={save} disabled={saving}>
                                {saving ? "Saving..." : "Save"}
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                        <span className="text-xs font-medium text-muted-foreground">{label}</span>
                        {editable ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                className="ml-auto"
                                onClick={() => {
                                    setDraft(text);
                                    setEditing(true);
                                }}
                            >
                                <Pencil className="size-4" />
                                Edit
                            </Button>
                        ) : null}
                    </>
                )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
                {editing ? (
                    <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        spellCheck={false}
                        className="h-full min-h-[50vh] w-full resize-none border-0 bg-transparent p-4 font-mono text-xs leading-relaxed outline-none"
                    />
                ) : (
                    <pre className="overflow-auto p-4 text-xs leading-relaxed">{text}</pre>
                )}
            </div>
        </div>
    );
}

// Register the link-hardening hook once (module-scoped): every anchor opens in a
// new tab and cannot reach back into the opener.
let purifyHooked = false;

/**
 * Render Markdown to sanitized HTML. Parsing (marked) and sanitizing (DOMPurify)
 * are dynamically imported so they never touch the main bundle. The sanitizer is
 * deliberately strict: style/link/iframe/script/form/object and inline `style`
 * attributes are stripped, so a document can never inject CSS, exfiltrate, or run
 * script - only formatting, links, and images survive. All same-origin.
 */
async function renderMarkdown(markdown: string): Promise<string> {
    const [{ marked }, purifyModule] = await Promise.all([import("marked"), import("dompurify")]);
    const DOMPurify = purifyModule.default;
    if (!purifyHooked) {
        DOMPurify.addHook("afterSanitizeAttributes", (node) => {
            if (node.tagName === "A") {
                node.setAttribute("target", "_blank");
                node.setAttribute("rel", "noopener noreferrer nofollow");
            }
        });
        purifyHooked = true;
    }
    const dirty = marked.parse(markdown, { async: false, gfm: true }) as string;
    return DOMPurify.sanitize(dirty, {
        FORBID_TAGS: [
            "style",
            "link",
            "iframe",
            "script",
            "form",
            "input",
            "button",
            "meta",
            "base",
            "object",
            "embed"
        ],
        FORBID_ATTR: ["style", "srcset", "onerror", "onload"],
        ADD_ATTR: ["target", "rel"]
    });
}

/** Tailwind styling for rendered Markdown (no typography plugin needed). */
const MARKDOWN_PROSE = cn(
    "max-w-none space-y-3 p-6 text-sm leading-relaxed",
    "[&_h1]:mt-2 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mt-2 [&_h2]:text-xl [&_h2]:font-semibold",
    "[&_h3]:text-lg [&_h3]:font-semibold [&_h4]:font-semibold",
    "[&_p]:leading-relaxed [&_a]:text-primary [&_a]:underline",
    "[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-0.5",
    "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs",
    "[&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
    "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
    "[&_hr]:my-4 [&_hr]:border-border [&_img]:max-w-full [&_img]:rounded",
    "[&_table]:w-full [&_table]:text-left [&_th]:border-b [&_th]:border-border [&_th]:p-2 [&_td]:border-b [&_td]:border-border [&_td]:p-2"
);

/**
 * Markdown viewer: sanitized rendered ("pretty") or raw source, and inline editing
 * that saves the file back through the upload route (guarded by write access).
 */
function MarkdownView({ src, target }: { src: string; target: ViewerTarget }) {
    const [text, setText] = useState<string | null>(null);
    const [error, setError] = useState(false);
    const [mode, setMode] = useState<"pretty" | "raw">("pretty");
    const [html, setHtml] = useState("");
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        setText(null);
        setError(false);
        setEditing(false);
        fetch(src)
            .then((response) => response.text())
            .then((body) => alive && setText(body.slice(0, 500_000)))
            .catch(() => alive && setError(true));
        return () => {
            alive = false;
        };
    }, [src]);

    useEffect(() => {
        if (text === null || editing || mode !== "pretty") return;
        let alive = true;
        void renderMarkdown(text).then((rendered) => {
            if (alive) setHtml(rendered);
        });
        return () => {
            alive = false;
        };
    }, [text, editing, mode]);

    async function save() {
        if (draft === text) {
            setEditing(false);
            return;
        }
        setSaving(true);
        setSaveError(null);
        const message = await saveTextFile(target, draft);
        if (message) {
            setSaveError(message);
            setSaving(false);
            return;
        }
        setText(draft);
        setEditing(false);
        setSaving(false);
    }

    if (error)
        return <p className="p-8 text-center text-sm text-danger">This file could not be read.</p>;
    if (text === null) return <Loading />;

    return (
        <div className="flex max-h-[80vh] flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                {editing ? (
                    <>
                        <span className="text-xs font-medium text-muted-foreground">Editing</span>
                        <div className="ml-auto flex items-center gap-2">
                            {saveError ? (
                                <span className="text-xs text-danger">{saveError}</span>
                            ) : null}
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                    setEditing(false);
                                    setSaveError(null);
                                }}
                                disabled={saving}
                            >
                                Cancel
                            </Button>
                            <Button size="sm" onClick={save} disabled={saving}>
                                {saving ? "Saving..." : "Save"}
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                            <button
                                type="button"
                                onClick={() => setMode("pretty")}
                                className={cn(
                                    "rounded px-2 py-1 text-xs transition-colors hover:bg-muted",
                                    mode === "pretty"
                                        ? "bg-muted font-medium"
                                        : "text-muted-foreground"
                                )}
                            >
                                Pretty
                            </button>
                            <button
                                type="button"
                                onClick={() => setMode("raw")}
                                className={cn(
                                    "rounded px-2 py-1 text-xs transition-colors hover:bg-muted",
                                    mode === "raw"
                                        ? "bg-muted font-medium"
                                        : "text-muted-foreground"
                                )}
                            >
                                Raw
                            </button>
                        </div>
                        <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto"
                            onClick={() => {
                                setDraft(text);
                                setEditing(true);
                            }}
                        >
                            <Pencil className="size-4" />
                            Edit
                        </Button>
                    </>
                )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
                {editing ? (
                    <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        spellCheck={false}
                        className="h-full min-h-[50vh] w-full resize-none border-0 bg-transparent p-4 font-mono text-xs leading-relaxed outline-none"
                    />
                ) : mode === "raw" ? (
                    <pre className="overflow-auto p-4 text-xs leading-relaxed">{text}</pre>
                ) : (
                    <div className={MARKDOWN_PROSE} dangerouslySetInnerHTML={{ __html: html }} />
                )}
            </div>
        </div>
    );
}
