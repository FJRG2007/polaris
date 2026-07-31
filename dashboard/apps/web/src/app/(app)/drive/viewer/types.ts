/**
 * Shared viewer contracts. Kept apart from the components so the editors, the
 * save layer and the explorers can import them without pulling the whole viewer
 * (and its dynamically imported libraries) into their module graph.
 */

export interface ViewerTarget {
    /** Source connection. Optional: a public share previews bytes through its own
     *  token route instead, supplying `urlFor` on the viewer rather than an id. */
    connectionId?: string;
    path: string;
    name: string;
    /** Byte size (serialized) and modified time, for the properties sidebar. */
    size?: string;
    modifiedAt?: string;
    /** Override for the sidebar "Location". A share passes a subtree-relative label
     *  so the raw connection path (and any folder above the shared root) never leaks. */
    locationLabel?: string;
}

/** Builds the byte URL for a target (inline preview or attachment download). */
export type ViewerUrlFor = (target: ViewerTarget, inline: boolean) => string;

export type ViewerKind =
    | "image"
    | "video"
    | "audio"
    | "pdf"
    | "sheet"
    | "doc"
    | "slides"
    | "markdown"
    | "code"
    | "text"
    | "none";

/**
 * Serializes an editor's current state for a destination name. The name's
 * extension decides the output format, so one editor can write both its own
 * format and a converted copy.
 */
export type EditorExport = (name: string) => Promise<Blob>;
