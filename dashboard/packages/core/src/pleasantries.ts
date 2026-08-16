/**
 * Whether a message is nothing but a pleasantry.
 *
 * A moderation queue is only worth reading if every row in it needs a decision,
 * and the rows that quietly ruin one are the reports of "hola", "thanks" and
 * "ok". There is nothing for anybody to act on there: the message is not abuse,
 * it is not spam, and the only outcome available is dismissing it. Enough of
 * them and the queue stops being read at all, which is the real cost.
 *
 * So a report of one is refused rather than filed - by the server, which is the
 * authority, and shown by the dialog before somebody presses send, which is the
 * courtesy. One function for both.
 *
 * **It errs towards letting the report through.** A false negative is a row a
 * moderator dismisses in a second; a false positive is somebody being told they
 * may not report something, which is the failure that matters. So the rule is
 * narrow and boring: every word has to be one of the pleasantries listed here,
 * at least one of them has to be a greeting or a thanks rather than filler, and
 * the whole thing has to be short. Anything else - a name, a link, a word this
 * list has never heard of - is a real message and is reportable.
 *
 * Words rather than phrases, because the phrase list is endless and the word
 * list is not: "buenos dias", "muy buenas", "hi there", "muchisimas gracias" and
 * "thank you all" are all covered by the same handful of tokens.
 */

/** The greetings, thanks and farewells that make a message a pleasantry. At
 *  least one of these has to be in it. */
const PLEASANTRIES = new Set([
    // Greetings.
    "hola", "ola", "hi", "hey", "hello", "helo", "alo", "alou", "aloha", "ey",
    "buenas", "wenas", "buen", "buena", "buenos", "good", "saludos", "greetings",
    "morning", "afternoon", "evening",
    "ciao", "salut", "bonjour", "oi", "yo",
    // Thanks.
    "gracias", "thanks", "thank", "thanx", "thx", "ty", "merci", "obrigado",
    "obrigada", "grazie", "danke", "cheers",
    // Farewells.
    "adios", "chao", "chau", "bye", "byebye", "goodbye", "hasta", "luego",
    "pronto", "manana", "cuidate", "regards",
    // Acknowledgements, which are the same kind of nothing.
    "ok", "oki", "okey", "okay", "vale", "listo", "perfecto", "perfect",
    "genial", "guay", "nice", "great", "cool", "welcome", "np", "nada"
]);

/**
 * Words that carry no meaning of their own here.
 *
 * They are allowed to appear beside a pleasantry - "buenos dias a todos", "thank
 * you very much" - but a message made only of these is not a pleasantry, it is
 * a fragment, and this says nothing about whether it is reportable.
 */
const FILLER = new Set([
    "a", "al", "all", "and", "are", "chicos", "day",
    "days", "de", "dia", "dias", "el", "equipo", "everybody", "everyone", "folks",
    "gente", "guys", "how", "hows", "is", "it", "la", "las", "los", "lot",
    "mucho", "muchas", "muchisimas", "muchisimo", "much", "muy", "night", "nights",
    "noche", "noches", "para", "por", "favor", "please", "que", "same", "so",
    "much", "tal", "tarde", "tardes", "team", "the", "there", "to", "todos",
    "todas", "u", "very", "was", "y", "you", "your", "yours", "everyone"
]);

/** The most words a pleasantry has. Past this it is a sentence, whatever it is
 *  made of, and a sentence is somebody's to report. */
const MOST_WORDS = 8;

/**
 * The words in a message, with everything that is not a letter or a digit taken
 * out: punctuation, emoji, the marks over accented letters, and the repetition
 * that makes "holaaa" its own spelling.
 *
 * Accents are folded rather than matched because "días" and "dias" are the same
 * word to anybody typing quickly, and a rule that only knew one of them would be
 * a rule that half the messages walked through.
 */
function words(text: string): string[] {
    return text
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        // A letter repeated three or more times is that letter twice, so
        // "holaaaaa" and "heyyyy" reduce to something the list can hold.
        .replace(/(.)\1{2,}/g, "$1$1")
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/** The same word with a doubled trailing letter dropped, so "holaa" and "heyy"
 *  are found in a list that spells them once. */
function trimmed(word: string): string {
    return word.replace(/(.)\1$/, "$1");
}

/**
 * Whether this is a message with nothing in it to act on.
 *
 * False for anything with a word this does not recognize, anything longer than a
 * greeting, and anything made only of filler - which includes the empty string,
 * because a message with no text at all is a message whose content is somewhere
 * else (a picture, a recording, a file) and that is exactly what somebody would
 * be reporting.
 */
export function isPleasantry(text: string): boolean {
    const found = words(text);
    if (found.length === 0 || found.length > MOST_WORDS) return false;

    let greeted = false;
    for (const word of found) {
        const known = PLEASANTRIES.has(word) || PLEASANTRIES.has(trimmed(word));
        if (known) {
            greeted = true;
            continue;
        }
        if (FILLER.has(word) || FILLER.has(trimmed(word))) continue;
        return false;
    }
    return greeted;
}

/** What somebody is told when they try to report one. Says why rather than
 *  refusing, because "no" on its own reads as a bug. */
export const PLEASANTRY_REFUSAL =
    "That message is a greeting, so there is nothing for a moderator to decide about it. Report the message that is actually the problem.";
