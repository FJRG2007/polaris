/**
 * Icon and color per file type, so a listing is readable at a glance: a
 * presentation, a spreadsheet and an archive should never look like the same
 * generic sheet of paper. Extensions map first (a PDF and a Word document are
 * both "documents" but deserve different marks); anything unmapped falls back to
 * its category from file-categories, then to a plain file icon.
 *
 * Colors are fixed Tailwind classes (never interpolated) so they survive the
 * production CSS build, and they follow the palette already used by the folder
 * icon picker.
 */

import {
    File,
    FileArchive,
    FileAudio,
    FileCode,
    FileImage,
    FileJson,
    FileSpreadsheet,
    FileTerminal,
    FileText,
    FileType,
    FileVideo,
    Presentation,
    type LucideIcon
} from "lucide-react";
import { categoryOfExtension, extensionOf, type FileCategory } from "./file-categories";

export interface FileIcon {
    readonly icon: LucideIcon;
    /** Tailwind text color class for the icon. */
    readonly className: string;
}

const GENERIC: FileIcon = { icon: File, className: "text-muted-foreground" };

/** Per-category defaults, used when an extension has no entry of its own. */
const BY_CATEGORY: Record<FileCategory, FileIcon> = {
    images: { icon: FileImage, className: "text-violet-400" },
    audio: { icon: FileAudio, className: "text-pink-400" },
    video: { icon: FileVideo, className: "text-sky-400" },
    // A word processor document carries the "type" mark; a pdf keeps the plain
    // sheet below, so the two do not read as the same thing in a listing.
    documents: { icon: FileType, className: "text-blue-400" },
    spreadsheets: { icon: FileSpreadsheet, className: "text-emerald-400" },
    presentations: { icon: Presentation, className: "text-orange-400" },
    text: { icon: FileText, className: "text-muted-foreground" },
    archives: { icon: FileArchive, className: "text-amber-400" }
};

/** Extensions that earn their own mark, beyond their category's default. */
const BY_EXTENSION: Record<string, FileIcon> = {
    pdf: { icon: FileText, className: "text-red-400" },
    json: { icon: FileJson, className: "text-amber-300" },
    sh: { icon: FileTerminal, className: "text-emerald-300" },
    bat: { icon: FileTerminal, className: "text-emerald-300" },
    ps1: { icon: FileTerminal, className: "text-emerald-300" },
    zsh: { icon: FileTerminal, className: "text-emerald-300" }
};

/** Source-code extensions, all sharing the code mark. */
const CODE_EXTENSIONS = [
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "py",
    "rs",
    "go",
    "java",
    "kt",
    "swift",
    "c",
    "h",
    "cpp",
    "hpp",
    "cs",
    "rb",
    "php",
    "sql",
    "html",
    "css",
    "scss",
    "vue",
    "svelte",
    "toml",
    "lua",
    "dart"
] as const;

for (const extension of CODE_EXTENSIONS) {
    BY_EXTENSION[extension] = { icon: FileCode, className: "text-cyan-400" };
}

/** The icon and color for a file name (never for a folder - see EntryIcon). */
export function fileIconFor(name: string): FileIcon {
    const extension = extensionOf(name);
    if (!extension) return GENERIC;
    const exact = BY_EXTENSION[extension];
    if (exact) return exact;
    const category = categoryOfExtension(extension);
    return category ? BY_CATEGORY[category] : GENERIC;
}
