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

/** What happened. "added" and "joined" differ by whether somebody else did it,
 *  and that is the whole content of the line; the three after them are
 *  moderation, which is written down for the same reason it is announced - a
 *  room where people quietly disappear is a room nobody trusts. The last is a
 *  call nobody picked up, which is the one line here that is not about who is in
 *  the room. */
export type ChatNoticeKind =
    | "joined"
    | "added"
    | "left"
    | "removed"
    | "banned"
    | "timedOut"
    | "missedCall"
    | "callStarted"
    | "callUnanswered"
    | "pinned";

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
        case "banned":
            return actor ? `${actor} banned ${who}` : `${who} was banned`;
        case "timedOut":
            return actor ? `${actor} timed ${who} out` : `${who} was timed out`;
        case "missedCall":
            // Written from the caller's side rather than the missed person's, so
            // one line is true for everybody who reads it: "Ana called - no
            // answer" to the room, "You called - no answer" to Ana. Saying
            // "missed call from Ana" would read as nonsense to Ana herself.
            //
            // It says nothing about whether somebody declined it. A refused call
            // and an unanswered one look the same from the other end, and that
            // is deliberate - it is the same silence the card that rang keeps.
            return `${who} called - no answer`;
        case "callStarted":
            return `${who} started a call`;
        case "pinned":
            // The message itself is in the bar above the conversation, which is
            // where the line points people.
            return `${who} pinned a message`;
        case "callUnanswered":
            // Follows the line that said the call started, which already names
            // who rang.
            return "Nobody answered the call";
    }
}

/** The kinds of conversation a call is announced in, the way a messenger
 *  does. A channel's call is a room people drop in and out of, and a line for
 *  every one would bury the conversation. */
export function announcesCalls(channelKind: string): boolean {
    return channelKind === "dm" || channelKind === "group";
}

/** How long a call lasted, as a sentence says it. */
export function callLength(ms: number): string {
    const minutes = Math.floor(Math.max(0, ms) / 60_000);
    if (minutes < 1) return "a few seconds";
    const count = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`;
    if (minutes < 60) return count(minutes, "minute");
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? count(hours, "hour") : `${count(hours, "hour")} ${count(rest, "minute")}`;
}

/** The stored body of the line written when a call that was answered ends. */
export function callEndedBody(ms: number): string {
    return `The call ended after ${callLength(ms)}`;
}

/** The accounts a notice names, so their current names can be looked up in one
 *  query for a whole page. */
export function noticePeople(body: string): string[] {
    const found = new Set<string>();
    for (const match of body.matchAll(MENTION)) found.add(match[2]!.toLowerCase());
    return [...found];
}

/** One piece of a notice as a reader sees it: words, or somebody named in it. */
export type NoticePart =
    | { readonly text: string }
    | { readonly userId: string; readonly name: string };

/**
 * A notice as one reader sees it, in pieces: the words, and every person named
 * in it with what they are called now - or the label stored with it when the
 * account is no longer there to ask - so each name can be pressed like a
 * mention.
 *
 * The reader is "you", which is what every messenger does and what stops
 * somebody being told their own name did something. Capitalised in the first
 * position and not after it, because the first mention in each of these
 * sentences is its subject: "You added Grace", "Grace added you".
 */
export function noticeParts(
    body: string,
    names: ReadonlyMap<string, string>,
    viewerId: string | null = null
): NoticePart[] {
    const you = viewerId?.toLowerCase() ?? null;
    const parts: NoticePart[] = [];
    let at = 0;
    let seen = 0;
    for (const match of body.matchAll(MENTION)) {
        const start = match.index ?? 0;
        if (start > at) parts.push({ text: body.slice(at, start) });
        const id = match[2]!;
        const key = id.toLowerCase();
        const first = seen === 0;
        seen += 1;
        const name =
            you && key === you
                ? first
                    ? "You"
                    : "you"
                : (names.get(key) ?? (match[1] || "Somebody"));
        parts.push({ userId: id, name });
        at = start + match[0].length;
    }
    if (at < body.length) parts.push({ text: body.slice(at) });
    return parts;
}

/** The same notice as one line of plain text. */
export function renderNotice(
    body: string,
    names: ReadonlyMap<string, string>,
    viewerId: string | null = null
): string {
    return noticeString(noticeParts(body, names, viewerId));
}

/** The plain text of parts already read from a notice. */
export function noticeString(parts: readonly NoticePart[]): string {
    return parts.map((part) => ("text" in part ? part.text : part.name)).join("");
}
