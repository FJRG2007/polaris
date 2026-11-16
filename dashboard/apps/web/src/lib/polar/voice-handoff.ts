/**
 * Ported from packages/app/src/voice/handoff.ts and search.ts of OpenCode
 * (github.com/sst/opencode, commit b083c4d510e4, MIT).
 *
 * What a Code session is sent when the words came from a voice call: a header
 * that says they were spoken (so recognition errors are read through, and the
 * reply leads with something that can be read aloud), then the instruction and
 * the surrounding conversation as JSON. The full header goes once per session
 * and again after half an hour without one; in between a short line points
 * back at it. `parseVoiceDelegation` reads the instruction back for the thread,
 * which shows what was asked rather than the envelope.
 *
 * Also the spoken session search: names arrive with filler, in any order and
 * sometimes misheard, so a title is matched word by word, forgiving one edit.
 *
 * Client-safe: no server imports.
 */

export const VOICE_HANDOFF_HEADER =
    "Voice delegation. The user is on a voice call with a voice agent, which hands their requests to you. Instruction is the user's own spoken words since the previous delegation, transcribed from speech, so it may contain recognition errors and disfluencies: resolve meaning from the complete utterance, not a disfluent prefix. Transcript delta is the surrounding voice conversation, both sides, for context, not additional commands. Lead your reply with one or two plain sentences suitable for reading aloud, then any detail; answer only what was asked, with no unrequested tips. If this arrives while you are already working (a follow-up, nudge, or status check), answer it promptly: a clear status update, the finished result if you have enough, or the precise blocker or input you need; then continue on the fastest safe path.";

export const VOICE_HANDOFF_CONTINUED = "Voice delegation (continued). Same fields as before.";

/** A session that goes this long without a delegation gets the full header again. */
export const VOICE_HEADER_LAPSE_MS = 30 * 60 * 1000;

export function formatHandoff(input: {
    instruction: string;
    transcript: readonly string[];
    context?: string | null;
    full: boolean;
}): string {
    // Keys in sorted order, as OpenCode writes them; JSON drops an undefined context.
    const body = {
        context: input.context?.trim() || undefined,
        instruction: input.instruction,
        transcript_delta: input.transcript
    };
    return `${input.full ? VOICE_HANDOFF_HEADER : VOICE_HANDOFF_CONTINUED}\n${JSON.stringify(body, null, 2)}`;
}

/** The instruction of a voice delegation, or null when the text is not one. */
export function parseVoiceDelegation(text: string): string | null {
    const header = text.startsWith(`${VOICE_HANDOFF_HEADER}\n`)
        ? VOICE_HANDOFF_HEADER
        : text.startsWith(`${VOICE_HANDOFF_CONTINUED}\n`)
          ? VOICE_HANDOFF_CONTINUED
          : null;
    if (!header) return null;
    try {
        const body: unknown = JSON.parse(text.slice(header.length + 1));
        if (body && typeof body === "object" && "instruction" in body) {
            const instruction = (body as { instruction: unknown }).instruction;
            if (typeof instruction === "string") return instruction;
        }
    } catch {
        // A message that only looks like one is shown as written.
    }
    return null;
}

const FILLER = new Set([
    "a", "an", "the", "my", "our", "that", "this", "one", "ones", "session", "sessions", "about",
    "for", "on", "in", "of", "to", "and", "with", "chat", "conversation", "called", "named",
    // The same words as a Spanish speaker says them.
    "el", "la", "los", "las", "un", "una", "mi", "mis", "ese", "esa", "este", "esta", "sesion",
    "sesiones", "sobre", "para", "en", "de", "del", "y", "con", "llamada", "llamado", "tarea"
]);

function normalize(text: string): string {
    return text
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

function withinOneEdit(a: string, b: string): boolean {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            i++;
            j++;
            continue;
        }
        if (++edits > 1) return false;
        if (a.length >= b.length) i++;
        if (a.length <= b.length) j++;
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
}

/** How well a spoken name matches a session: undefined for no match, higher is better. */
export function sessionMatch(query: string, session: { title: string; repo: string }): number | undefined {
    const phrase = normalize(query);
    const words = phrase.split(" ").filter(Boolean);
    const meaningful = words.filter((word) => !FILLER.has(word));
    const terms = meaningful.length ? meaningful : words;
    if (!terms.length) return undefined;
    const title = normalize(session.title);
    // The meaningful words count as the phrase too: "the hex session" names HEX exactly.
    const named = terms.join(" ");
    if (title === phrase || title === named) return 100;
    if (title.includes(phrase) || title.includes(named)) return 80;
    const haystack = `${title} ${normalize(session.repo)}`.split(" ").filter(Boolean);
    const joined = haystack.join("");
    const matched = terms.filter(
        (term) =>
            haystack.some((word) => word.startsWith(term) || (term.length >= 5 && withinOneEdit(word, term))) ||
            (term.length >= 4 && joined.includes(term))
    ).length;
    if (matched === terms.length) return 50 + matched * 5;
    if (matched > 0 && matched * 2 >= terms.length) return 20 + matched * 5;
    return undefined;
}
