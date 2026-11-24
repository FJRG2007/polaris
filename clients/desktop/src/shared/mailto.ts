/**
 * `mailto:` links, which this app answers once it is chosen for them in the
 * system's default apps (`main/mail-handler` puts it on that list).
 *
 * A link opens Mail's composer on the Polaris in use, at the page the web app
 * already has for exactly this (`/mail/compose?url=mailto:...`), so what a link
 * may fill in is decided there and nowhere else. Like a polaris:// link it only
 * ever names a page: nothing is sent until somebody presses Send.
 */

/** The longest link handed on; a longer one is cut off by nobody, it is refused. */
const MAX_LENGTH = 8192;

/** The composer's path for a link, or null when it is not a mailto link. */
export function mailtoPath(value: unknown): string | null {
    if (typeof value !== "string" || value.length > MAX_LENGTH) return null;
    if (!/^mailto:/i.test(value)) return null;
    if (/[\u0000-\u001f\u007f]/.test(value)) return null;
    return `/mail/compose?url=${encodeURIComponent(value)}`;
}

/** The mailto link among a process's arguments, which is how Windows and Linux hand it over. */
export function mailtoIn(argv: readonly string[]): string | null {
    for (const argument of argv) {
        const path = mailtoPath(argument);
        if (path) return path;
    }
    return null;
}
