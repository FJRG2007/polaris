/**
 * How an unread count is written on a badge. Two characters is all a dot beside
 * the bell or a 16px tab icon can carry legibly, so anything past nine reads as
 * "9+". Shared so the bell and the favicon never disagree about the number.
 */
export function badgeLabel(unread: number): string | null {
    if (!Number.isFinite(unread) || unread < 1) return null;
    return unread > 9 ? "9+" : String(Math.trunc(unread));
}
