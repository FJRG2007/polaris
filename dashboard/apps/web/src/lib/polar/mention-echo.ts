/**
 * Whether a mention's answer is only its own prompt handed back.
 *
 * A model too small for a conversation, shown a transcript of `Name: text`
 * lines, continues the transcript rather than answering it: asked
 * `@polar que tal?` by Javier, it writes `Javier: @polar que tal?`. Posted,
 * that reads as Polar mocking the question. Such an answer is the model
 * failing, and the next model is asked instead. Pure, isomorphic.
 */

/** What the answer is checked against. */
export interface EchoContext {
    /** The prompt the model was sent. */
    readonly prompt: string;
    /** The question as the asker wrote it. */
    readonly question: string;
    /** The people whose lines the prompt holds, the asker among them. */
    readonly names: readonly string[];
}

/** An answer shorter than this is only an echo when it is a whole line. */
const CONTAINED_MIN_CHARS = 24;

/** Lower case, no mention, no Markdown quoting or emphasis, one space. */
function plain(text: string): string {
    return text
        .toLowerCase()
        .replace(/(^|[^\w@])@polar(?![\w-])/g, "$1")
        .replace(/^\s*>+\s?/gm, "")
        .replace(/[*_`~]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function escaped(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `text` is its prompt, the question or the conversation handed back. Pure. */
export function echoesPrompt(text: string, context: EchoContext): boolean {
    const said = plain(text);
    if (!said) return false;
    const question = plain(context.question);
    if (question && said === question) return true;
    const names = context.names.map((name) => name.trim()).filter(Boolean);
    const speaker = names.length
        ? new RegExp(`^(?:${names.map(escaped).join("|")})\\s*:`, "i")
        : null;
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    // A transcript: every line opens with somebody's name and a colon.
    if (speaker && lines.length > 0 && lines.every((line) => speaker.test(plain(line)))) return true;
    const prompt = plain(context.prompt);
    const promptLines = new Set(context.prompt.split(/\r?\n/).map(plain).filter(Boolean));
    if (promptLines.has(said)) return true;
    return said.length >= CONTAINED_MIN_CHARS && prompt.includes(said);
}
