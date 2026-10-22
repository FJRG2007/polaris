/**
 * The few words a key draws itself, in English and Spanish.
 *
 * Everything else a key shows - action names, refusals - comes from Polaris in
 * the account's language. These are for when Polaris cannot be asked. Pure.
 */

const WORDS = {
    en: {
        connect: "Connect",
        offline: "Offline",
        signIn: "Sign in",
        pick: "Pick one",
        done: "Done",
        again: "Again?",
        reconnect: "Reconnect"
    },
    es: {
        connect: "Conectar",
        offline: "Sin red",
        signIn: "Entrar",
        pick: "Elegir",
        done: "Hecho",
        again: "¿Otra?",
        reconnect: "Reconectar"
    }
} as const;

export type WordKey = keyof (typeof WORDS)["en"];

/** The words for the Stream Deck app's language; English for any other. */
export function wordsFor(language: string | undefined): Readonly<Record<WordKey, string>> {
    return language === "es" ? WORDS.es : WORDS.en;
}
