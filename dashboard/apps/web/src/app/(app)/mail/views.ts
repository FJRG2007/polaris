/**
 * The merged views, in one table.
 *
 * Each is a role every mailbox has under a name of its own choosing, so the
 * merged Sent is "whatever each of these servers calls Sent" rather than a
 * folder path. The empty states are here too, because the difference between
 * "no mail" and "nothing in the trash" is the difference between a screen that
 * reads as finished and one that reads as broken.
 */

import type { ListRoute } from "./list-page";

/**
 * `drafts` is deliberately not here.
 *
 * Polaris' drafts and the Drafts folder on the mail server are not the same
 * thing: the composer saves as somebody types, and the server's folder only gets
 * a copy when the composer closes - one sync leaves out - so listing that folder
 * would show nothing of what was written here. `/mail/drafts` is a screen of its
 * own.
 */
export const MAIL_VIEWS: Readonly<Record<string, ListRoute>> = {
    inbox: {
        view: "inbox",
        narrow: { role: "inbox" },
        categorised: true,
        context: {
            canArchive: true,
            permanentDelete: false,
            restorable: false,
            emptyRole: ""
        }
    },
    starred: {
        view: "starred",
        narrow: { starredOnly: true },
        context: {
            canArchive: true,
            permanentDelete: false,
            restorable: false,
            emptyRole: ""
        }
    },
    important: {
        view: "important",
        narrow: { importantOnly: true },
        context: {
            canArchive: true,
            permanentDelete: false,
            restorable: false,
            emptyRole: ""
        }
    },
    snoozed: {
        view: "snoozed",
        narrow: { snoozedOnly: true },
        context: {
            canArchive: true,
            permanentDelete: false,
            restorable: false,
            emptyRole: ""
        }
    },
    sent: {
        view: "sent",
        narrow: { role: "sent" },
        context: {
            canArchive: true,
            permanentDelete: false,
            restorable: false,
            emptyRole: ""
        }
    },
    archive: {
        view: "archive",
        narrow: { role: "archive" },
        context: {
            canArchive: false,
            permanentDelete: false,
            restorable: false,
            emptyRole: ""
        }
    },
    junk: {
        view: "junk",
        narrow: { role: "junk" },
        context: {
            canArchive: false,
            permanentDelete: true,
            // Spam has "Not spam", which files it back in the inbox and teaches
            // the filter. Putting it back where it was would teach nothing.
            restorable: false,
            emptyRole: "junk"
        }
    },
    trash: {
        view: "trash",
        narrow: { role: "trash" },
        context: {
            canArchive: false,
            permanentDelete: true,
            restorable: true,
            emptyRole: "trash"
        }
    }
};
