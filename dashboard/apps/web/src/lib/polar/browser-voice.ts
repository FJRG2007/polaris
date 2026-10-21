/**
 * The voice Polar falls back on when no key here can speak: the browser's own
 * text to speech (the Web Speech API's `speechSynthesis`). It needs no key and
 * no request, so an answer is always said out loud where the browser has a
 * voice at all.
 *
 * Client-only, but nothing runs on import: every function checks the API is
 * there first.
 */

/** The parts of a `SpeechSynthesisVoice` a choice is made on. */
export interface VoiceLike {
    lang: string;
    default: boolean;
}

function normalized(lang: string): string {
    return lang.replace(/_/g, "-").toLowerCase();
}

/**
 * The voice to say something in `lang` with: one for that exact language
 * ("es-ES") before one for the language anywhere ("es-MX"), the browser's
 * default before the rest. Null when none speaks it, and the browser's own
 * choice is left to `lang` alone.
 */
export function pickBrowserVoice<V extends VoiceLike>(
    voices: readonly V[],
    lang: string
): V | null {
    const wanted = normalized(lang);
    const primary = wanted.split("-")[0] ?? "";
    const exact = voices.filter((voice) => normalized(voice.lang) === wanted);
    const near = voices.filter((voice) => normalized(voice.lang).split("-")[0] === primary);
    return (
        exact.find((voice) => voice.default) ??
        exact[0] ??
        near.find((voice) => voice.default) ??
        near[0] ??
        null
    );
}

/** Whether this browser can speak at all. */
export function browserCanSpeak(): boolean {
    return (
        typeof window !== "undefined" &&
        typeof window.speechSynthesis !== "undefined" &&
        typeof window.SpeechSynthesisUtterance !== "undefined"
    );
}

/** The voices, which some browsers only list after `voiceschanged`. */
function voices(): Promise<SpeechSynthesisVoice[]> {
    const synth = window.speechSynthesis;
    const now = synth.getVoices();
    if (now.length > 0) return Promise.resolve(now);
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            synth.removeEventListener?.("voiceschanged", done);
            resolve(synth.getVoices());
        };
        const timer = setTimeout(done, 1000);
        synth.addEventListener?.("voiceschanged", done);
    });
}

/** Utterances being said. Chrome drops the events of one nothing holds on to. */
const held = new Set<SpeechSynthesisUtterance>();

export interface BrowserSpeech {
    /** Settles when the sentence has been said, cut short or failed. */
    done: Promise<void>;
    cancel: () => void;
}

/**
 * Says `text` in `lang` with the browser's voice. `onWord` is called at each
 * word it reaches, where the browser reports them, so a level can follow it.
 */
export function speakInBrowser(text: string, lang: string, onWord?: () => void): BrowserSpeech {
    let cancelled = false;
    let utterance: SpeechSynthesisUtterance | null = null;
    const done = voices().then(
        (list) =>
            new Promise<void>((resolve) => {
                if (cancelled) return resolve();
                const said = new SpeechSynthesisUtterance(text);
                utterance = said;
                said.lang = lang;
                const voice = pickBrowserVoice(list, lang);
                if (voice) said.voice = voice;
                const finish = () => {
                    held.delete(said);
                    resolve();
                };
                said.onend = finish;
                said.onerror = finish;
                said.onboundary = () => onWord?.();
                held.add(said);
                window.speechSynthesis.speak(said);
            })
    );
    return {
        done,
        cancel: () => {
            cancelled = true;
            if (utterance) {
                held.delete(utterance);
                window.speechSynthesis.cancel();
            }
        }
    };
}
