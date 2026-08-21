/**
 * Which viewer a file opens in, by its name alone.
 *
 * Kept apart from the viewer itself so that asking the question costs nothing.
 * `file-viewer.tsx` imports every view it can render - a spreadsheet grid, a
 * document converter, a PDF engine - and a screen that only wants to know
 * whether a file is worth offering to open must not pull all of that in to find
 * out. The chat message list is exactly that screen.
 */

import { extensionOf } from "../file-categories";
import { languageForFile } from "@/lib/code-language";
import type { ViewerKind } from "./types";

const IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif", "ico"]);
const VIDEO = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const AUDIO = new Set(["mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "opus"]);
const SHEET = new Set(["xlsx", "xls", "csv", "ods", "tsv"]);
const DOC = new Set(["docx"]);
const SLIDES = new Set(["pptx", "ppsx", "potx"]);
const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd"]);

/**
 * Which viewer renders a file by its extension. A file the highlighter has a
 * grammar for opens as code; anything without a richer viewer falls back to
 * "text" - the Notepad-style editor opens it as plain text.
 */
export function viewerKind(name: string): ViewerKind {
    const ext = extensionOf(name);
    if (IMAGE.has(ext)) return "image";
    if (VIDEO.has(ext)) return "video";
    if (AUDIO.has(ext)) return "audio";
    if (ext === "pdf") return "pdf";
    if (SHEET.has(ext)) return "sheet";
    if (DOC.has(ext)) return "doc";
    if (SLIDES.has(ext)) return "slides";
    if (MARKDOWN.has(ext)) return "markdown";
    if (languageForFile(name)) return "code";
    return "text";
}

/** Whether a file can be opened in the viewer (drives the click behavior). */
export function isViewable(name: string): boolean {
    return viewerKind(name) !== "none";
}
