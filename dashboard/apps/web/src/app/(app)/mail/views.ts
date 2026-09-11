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
        narrow: { role: "inbox" },
        categorised: true,
        context: {
            title: "Inbox",
            emptyTitle: "Nothing waiting",
            emptyBody: "Everything that has arrived is dealt with.",
            canArchive: true,
            permanentDelete: false,
            restorable: false,
            emptyRole: ""
        }
    },
    starred: {
        narrow: { starredOnly: true },
        context: {
            title: "Starred",
            emptyTitle: "Nothing starred",
            emptyBody: "Star a conversation to keep it here, across every mailbox.",
            canArchive: true,
            permanentDelete: false,
            restorable: false,
            emptyRole: ""
        }
    },
    important: {
        narrow: { importantOnly: true },
        context: {
            title: "Important",
            emptyTitle: "Nothing marked important",
            emptyBody: "Mark a message important to keep it here, across every mailbox.",
            canArchive: true,
            permanentDelete: false,
            restorable: false,
            emptyRole: ""
        }
    },
    snoozed: {
        narrow: { snoozedOnly: true },
        context: {
            title: "Snoozed",
            emptyTitle: "Nothing put off",
            emptyBody: "A conversation you snooze drops out of the inbox until the hour you chose.",
            canArchive: true,
            permanentDelete: false,
            restorable: false,
            emptyRole: ""
        }
    },
    sent: {
        narrow: { role: "sent" },
        context: {
            title: "Sent",
            emptyTitle: "Nothing sent yet",
            emptyBody: "Messages you send appear here, across every mailbox.",
            canArchive: true,
            permanentDelete: false,
            restorable: false,
            emptyRole: ""
        }
    },
    archive: {
        narrow: { role: "archive" },
        context: {
            title: "Archive",
            emptyTitle: "Nothing archived",
            emptyBody: "Archiving takes a conversation out of the inbox without deleting it.",
            canArchive: false,
            permanentDelete: false,
            restorable: false,
            emptyRole: ""
        }
    },
    junk: {
        narrow: { role: "junk" },
        context: {
            title: "Spam",
            emptyTitle: "No spam",
            emptyBody: "What your mail server marks as spam ends up here.",
            canArchive: false,
            permanentDelete: true,
            // Spam has "Not spam", which files it back in the inbox and teaches
            // the filter. Putting it back where it was would teach nothing.
            restorable: false,
            emptyRole: "junk"
        }
    },
    trash: {
        narrow: { role: "trash" },
        context: {
            title: "Trash",
            emptyTitle: "The trash is empty",
            emptyBody: "Deleted conversations wait here until the mail server clears them out.",
            canArchive: false,
            permanentDelete: true,
            restorable: true,
            emptyRole: "trash"
        }
    }
};
