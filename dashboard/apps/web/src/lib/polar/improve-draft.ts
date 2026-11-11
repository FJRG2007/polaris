/**
 * The pure half of improving a draft (`improve-text.ts`): what may be asked
 * for, and what the model's answer is cut down to. Shared with the route that
 * validates the request.
 */

/** What is being improved, which decides what "better" means. */
export const IMPROVE_PURPOSES = ["prompt", "email"] as const;
export type ImprovePurpose = (typeof IMPROVE_PURPOSES)[number];

/** Longest draft taken, in characters. The composers' own limit. */
export const IMPROVE_TEXT_MAX = 20_000;

/**
 * The model's answer as the new draft: a reasoning model's stray thinking
 * block and a wrapping code fence or quotes dropped, and nothing left over the
 * limit. Null when nothing usable remains. Pure.
 */
export function cleanImproved(raw: string): string | null {
    let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text);
    if (fenced?.[1]) text = fenced[1].trim();
    const quoted = /^["“”«](.*)["“”»]$/s.exec(text);
    if (quoted?.[1] && !quoted[1].includes("\n")) text = quoted[1].trim();
    if (!text) return null;
    return text.length > IMPROVE_TEXT_MAX ? text.slice(0, IMPROVE_TEXT_MAX) : text;
}
