/**
 * File type taxonomy shared by the Files filter chips and the file-request
 * builder. Each category maps to the extensions that identify it and the MIME
 * prefixes/types a server can allow. Kept as plain data (no React) so both the
 * client filter UI and the file-request schema construction can consume it.
 */

export type FileCategory =
    | "images"
    | "audio"
    | "video"
    | "documents"
    | "spreadsheets"
    | "presentations"
    | "text"
    | "archives";

export interface CategoryDef {
    readonly id: FileCategory;
    readonly label: string;
    /** Lowercase, dot-less extensions that belong to this category. */
    readonly extensions: readonly string[];
    /** Full MIME types or "type/" prefixes that belong to this category. */
    readonly mimeTypes: readonly string[];
}

export const FILE_CATEGORIES: readonly CategoryDef[] = [
    {
        id: "images",
        label: "Images",
        extensions: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "tiff", "tif", "heic", "avif", "ico"],
        mimeTypes: ["image/"]
    },
    {
        id: "audio",
        label: "Audio",
        extensions: ["mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "wma", "opus"],
        mimeTypes: ["audio/"]
    },
    {
        id: "video",
        label: "Video",
        extensions: ["mp4", "mkv", "mov", "avi", "webm", "wmv", "flv", "m4v", "mpg", "mpeg", "3gp"],
        mimeTypes: ["video/"]
    },
    {
        id: "documents",
        label: "Documents",
        extensions: ["pdf", "doc", "docx", "odt", "rtf", "pages", "epub"],
        mimeTypes: [
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.oasis.opendocument.text",
            "application/epub+zip"
        ]
    },
    {
        id: "spreadsheets",
        label: "Spreadsheets",
        extensions: ["xls", "xlsx", "ods", "csv", "tsv", "numbers"],
        mimeTypes: [
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.oasis.opendocument.spreadsheet",
            "text/csv"
        ]
    },
    {
        id: "presentations",
        label: "Presentations",
        extensions: ["ppt", "pptx", "odp", "key"],
        mimeTypes: [
            "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.oasis.opendocument.presentation"
        ]
    },
    {
        id: "text",
        label: "Plain text",
        extensions: ["txt", "md", "markdown", "log", "json", "xml", "yaml", "yml", "ini", "conf", "csv"],
        mimeTypes: ["text/plain", "text/markdown", "application/json", "application/xml"]
    },
    {
        id: "archives",
        label: "Compressed",
        extensions: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst"],
        mimeTypes: ["application/zip", "application/x-7z-compressed", "application/x-rar-compressed", "application/gzip"]
    }
] as const;

const BY_ID = new Map<FileCategory, CategoryDef>(FILE_CATEGORIES.map((category) => [category.id, category]));

const EXTENSION_INDEX: ReadonlyMap<string, FileCategory> = (() => {
    const index = new Map<string, FileCategory>();
    for (const category of FILE_CATEGORIES) {
        for (const extension of category.extensions) {
            // First category to claim an extension wins; the list order above is the
            // precedence (e.g. csv resolves to spreadsheets before text).
            if (!index.has(extension)) index.set(extension, category.id);
        }
    }
    return index;
})();

/** Lowercase, dot-less extension of a filename ("" when there is none). */
export function extensionOf(name: string): string {
    const dot = name.lastIndexOf(".");
    if (dot <= 0 || dot === name.length - 1) return "";
    return name.slice(dot + 1).toLowerCase();
}

/** Category an extension belongs to, or undefined when it matches none. */
export function categoryOfExtension(extension: string): FileCategory | undefined {
    return EXTENSION_INDEX.get(extension.toLowerCase());
}

/** Look up a category definition by id. */
export function categoryDef(id: FileCategory): CategoryDef | undefined {
    return BY_ID.get(id);
}
