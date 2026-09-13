/**
 * How much of a mailbox Polaris keeps the words of.
 *
 * A synced message is an envelope - who it is from, its subject, its flags - and
 * that is a few hundred bytes. The message itself is not: a newsletter is a
 * hundred kilobytes of markup and a thread with a deck quoted into it is far
 * more. Polaris brings those down as mail arrives, because a message whose body
 * is already here opens instantly and one whose body is not costs a whole IMAP
 * session - connect, authenticate, select, fetch - between the click and the
 * words.
 *
 * Doing that without a limit is not a cache, it is a slow download of somebody's
 * entire mail history onto this disk. So it is a window: the newest N messages of
 * each mailbox keep their body and the rest let theirs go. Anything outside still
 * opens - it is fetched then, the way it always was, and held until it falls out
 * again.
 *
 * N is the number that decides the disk, roughly `N x the average body x the
 * number of mailboxes`, which is why it is an operator's setting rather than a
 * constant. Pure on purpose: what a stored string means is worth being able to
 * test without a database.
 */

/** The Setting key holding the window, in messages. Absent, the default applies. */
export const MAIL_BODY_KEEP_KEY = "mail.body.keep";

/**
 * How many messages of each mailbox keep their body when nobody has said
 * otherwise.
 *
 * Five hundred is several months of ordinary mail and far more than anybody
 * opens cold, at roughly twenty megabytes a mailbox. Past it, opening a message
 * costs what opening a message used to cost - which is the right trade for mail
 * from last spring.
 */
export const MAIL_BODY_KEEP_DEFAULT = 500;

/**
 * The largest window an operator may set.
 *
 * A ceiling rather than a free number because this one is spent on a disk that
 * fills quietly: the symptom of setting it too high is not an error, it is a
 * server that stops being able to write anything at all some weeks later. Five
 * thousand is years of a busy mailbox and already far past where holding more
 * buys anybody a faster open.
 */
export const MAIL_BODY_KEEP_MAX = 5000;

/**
 * Read an operator's stored value, falling back to the default for anything that
 * is not a number in range.
 *
 * Never throws. A setting nobody can parse is not a reason to stop syncing mail,
 * and the failure it would cause - a sync pass that dies before it writes what
 * arrived - is far worse than the wrong window.
 *
 * Zero is honoured and means hold nothing ahead of time: every message is
 * fetched when somebody opens it. A deployment short of disk, or one whose mail
 * server is on the same LAN and answers in a millisecond, has nothing to gain
 * from the window and can say so.
 */
export function mailBodyKeep(stored: string | null | undefined): number {
    if (stored === null || stored === undefined || stored.trim() === "")
        return MAIL_BODY_KEEP_DEFAULT;
    const parsed = Number.parseInt(stored, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return MAIL_BODY_KEEP_DEFAULT;
    return Math.min(parsed, MAIL_BODY_KEEP_MAX);
}
