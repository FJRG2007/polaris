/**
 * The wording of the lines Polaris writes into a conversation itself: somebody
 * joined, somebody was added, somebody left.
 *
 * Kept apart from the writer next door so it can be read and tested without a
 * database, and because the two halves change for different reasons - one is
 * English, the other is when a row is written.
 *
 * **The people in a notice are stored as mentions, not as names.** The body of
 * `[Ada Lovelace](polaris:user/0193...) joined` is the same reference shape
 * every message in Polaris carries, which buys two things: the row still reads
 * as a sentence to anybody looking at the database, and the name is resolved
 * again when the message is drawn - so a rename does not leave a year of
 * notices calling somebody what they used to be called, and a reader who has
 * their own name for a person sees that one here as well as everywhere else.
 *
 * The label written into the row is the name at the time, which is what any
 * reader falls back to if the account is gone by then.
 */

/** What happened. Four kinds, because "added" and "joined" differ by whether
 *  somebody else did it, and that is the whole content of the line. */
export type ChatNoticeKind = "joined" | "added" | "left" | "removed";

/** Somebody a notice names. */
export interface NoticePerson {
    readonly id: string;
    /** What they were called when it was written. Only a fallback: the name is
     *  resolved again at read time. */
    readonly name: string;
}

/**
 * Every mention in a notice, as `[label](polaris:user/id)`.
 *
 * Its own small pattern rather than the Markdown parser: a notice is one
 * sentence this file wrote, and parsing a document to read it back is a
 * document parse on every message of a page.
 *
 * The id is taken as whatever sits between the slash and the bracket, rather
 * than as the uuid shape ids have had since 2025. An account older than that
 * carries a different one, and a pattern that insisted would not merely fail to
 * find the name - it would leave the whole `[Name](polaris:user/...)` on screen,
 * which is the one outcome worse than a stale name. Anything that does not
 * resolve falls back to the label beside it.
 */
const MENTION = /\[([^\]]*)\]\(polaris:user\/([^)\s]+)\)/gi;

/** A name with the two characters that would break the link syntax taken out.
 *  Nothing else is escaped: the label is replaced at read time anyway. */
function label(name: string): string {
    return name.replace(/[[\]]/g, "").trim() || "Somebody";
}

function mention(person: NoticePerson): string {
    return `[${label(person.name)}](polaris:user/${person.id})`;
}

/**
 * The stored body of a notice.
 *
 * @param by - Who did it, when somebody did it to somebody else. Null when the
 *   person acted on themselves, and also the fallback wording for a change with
 *   nobody behind it.
 */
export function noticeBody(
    kind: ChatNoticeKind,
    person: NoticePerson,
    by: NoticePerson | null = null
): string {
    const who = mention(person);
    const actor = by && by.id !== person.id ? mention(by) : null;
    switch (kind) {
        case "joined":
            return `${who} joined`;
        case "added":
            return actor ? `${actor} added ${who}` : `${who} was added`;
        case "left":
            return `${who} left`;
        case "removed":
            return actor ? `${actor} removed ${who}` : `${who} was removed`;
    }
}

/** The accounts a notice names, so their current names can be looked up in one
 *  query for a whole page. */
export function noticePeople(body: string): string[] {
    const found = new Set<string>();
    for (const match of body.matchAll(MENTION)) found.add(match[2]!.toLowerCase());
    return [...found];
}

/**
 * A notice as one reader sees it: plain text, with every mention replaced by
 * what that person is called now - or by the label stored with it when the
 * account is no longer there to ask.
 *
 * The reader is "you", which is what every messenger does and what stops
 * somebody being told their own name did something. Capitalised in the first
 * position and not after it, because the first mention in each of these
 * sentences is its subject: "You added Grace", "Grace added you".
 */
export function renderNotice(
    body: string,
    names: ReadonlyMap<string, string>,
    viewerId: string | null = null
): string {
    const you = viewerId?.toLowerCase() ?? null;
    let seen = 0;
    return body.replace(MENTION, (_whole, stored: string, id: string) => {
        const key = id.toLowerCase();
        const first = seen === 0;
        seen += 1;
        if (you && key === you) return first ? "You" : "you";
        return names.get(key) ?? stored ?? "Somebody";
    });
}
