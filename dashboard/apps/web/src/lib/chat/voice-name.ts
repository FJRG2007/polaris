/**
 * The name a recorded voice message is sent under, and how one is recognised
 * by it. Kept apart from the recorder so the server can tell one apart too,
 * and so the name and the pattern that reads it cannot drift.
 */

/** The name the recording is sent under. Plain and the same every time: the
 *  message says when it was said, and a name with a timestamp in it says it
 *  again, differently. */
export function voiceFileName(type: string): string {
    const container = type.split(";")[0]?.trim() ?? "";
    const extension =
        container === "audio/mp4" ? "m4a" : container === "audio/ogg" ? "ogg" : "webm";
    return `voice-message.${extension}`;
}

/** Whether a file name is the one a recording is sent under. */
export function isVoiceFileName(name: string): boolean {
    return /^voice-message\.[a-z0-9]+$/i.test(name);
}
