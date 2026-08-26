/**
 * The parts of the PDF surface that are decisions rather than rendering: what
 * the zoom control offers and reads, which page a typed value means, and how a
 * search result is worded. Kept apart from the components so they can be
 * asserted without a document, a canvas or a worker.
 */

/** Zoom settings that follow the window rather than naming a size. */
export const ZOOM_PRESETS = [
    { value: "auto", label: "Automatic" },
    { value: "page-actual", label: "Actual size" },
    { value: "page-fit", label: "Fit page" },
    { value: "page-width", label: "Fit width" }
] as const;

/** Fixed magnifications, offered under the presets. */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

/**
 * What the zoom control shows. pdf.js reports a preset name only while one is
 * in force: stepping the zoom clears it, and the magnification itself is what
 * the reader wants to see from then on.
 */
export function zoomLabel(scale: number, scaleValue?: string): string {
    const preset = ZOOM_PRESETS.find((option) => option.value === scaleValue);
    return preset ? preset.label : `${Math.round(scale * 100)}%`;
}

/**
 * The zoom control's options and which of them is in force. Stepping the zoom
 * lands on magnifications that are on no list, so the current one joins the
 * list rather than leaving the control showing nothing.
 */
export function zoomChoices(
    scale: number,
    scaleValue?: string
): { value: string; options: { value: string; label: string }[] } {
    const value = scaleValue ?? String(scale);
    const options = [
        ...ZOOM_PRESETS.map((preset) => ({ value: preset.value, label: preset.label })),
        ...ZOOM_STEPS.map((step) => ({ value: String(step), label: `${Math.round(step * 100)}%` }))
    ];
    if (!options.some((option) => option.value === value))
        options.push({ value, label: zoomLabel(scale, scaleValue) });
    return { value, options };
}

/** The page a typed value jumps to, or null when it names no page in this document. */
export function pageFromInput(raw: string, numPages: number): number | null {
    const page = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(page) || page < 1 || page > numPages) return null;
    return page;
}

export type FindStatus = "idle" | "pending" | "found" | "not-found" | "wrapped";

/**
 * The count beside the search box. A finished search with no matches and a
 * document still being scanned read differently, and an empty box says nothing
 * at all rather than "no matches" over a query nobody typed.
 */
export function matchSummary(status: FindStatus, current: number, total: number): string {
    if (status === "idle") return "";
    if (status === "pending") return "Searching...";
    if (status === "not-found" || total === 0) return "No matches";
    return `${current} of ${total}`;
}
