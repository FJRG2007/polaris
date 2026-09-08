/**
 * How an unread count is written on a badge. Two characters is all a dot beside
 * the bell or a 16px tab icon can carry legibly, so anything past nine reads as
 * "9+". Shared so the bell and the favicon never disagree about the number.
 */
export function badgeLabel(unread: number): string | null {
    if (!Number.isFinite(unread) || unread < 1) return null;
    return unread > 9 ? "9+" : String(Math.trunc(unread));
}

/**
 * What a badge is counting, in words, for the places that say it out loud.
 *
 * The badge machinery deliberately does not know which app it is drawing - see
 * `app-unread` - so every one of these read "unread messages". Which is right
 * for Chat and Mail and wrong for Management, where the number is reported
 * messages and an update nobody has installed. The words come from the app
 * catalogue; messages are what an app that does not say gets.
 */
export function waitingSays(count: number, words?: { one: string; many: string }): string {
    const noun = words
        ? count === 1
            ? words.one
            : words.many
        : count === 1
          ? "unread message"
          : "unread messages";
    return `${count} ${noun}`;
}
