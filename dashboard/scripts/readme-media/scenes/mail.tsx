/** Mail: every mailbox in one inbox. */

import { Chrome } from "../runtime/chrome";
import { label } from "../runtime/interact";
import { defineScene } from "../runtime/scene";
import { VIEWER } from "../fixtures/people";
import { MAIL_PREF_DEFAULTS, DEFAULT_MAIL_SORT } from "@polaris/core";
import { MailShell } from "@/app/(app)/mail/mail-shell";
import { MailView } from "@/app/(app)/mail/mail-view";
import { MAIL_VIEWS } from "@/app/(app)/mail/views";
import {
    OPEN_THREAD_ID,
    mailAccounts,
    mailFolders,
    mailIdentities,
    mailLabels,
    mailThreads,
    mailUnread,
    openThread,
    openedMessage
} from "../fixtures/mail";
import type { SceneContext } from "../runtime/scene";

/** The pages under `/mail` inside the mail layout, with nothing or one conversation open. */
function Inbox({ ctx, open }: { ctx: SceneContext; open: boolean }) {
    return (
        <Chrome unread={{ mail: 6 }}>
            <MailShell
                accounts={mailAccounts(ctx)}
                folders={mailFolders()}
                labels={mailLabels(ctx)}
                identities={mailIdentities()}
                unread={mailUnread(false)}
                viewerName={VIEWER.name}
                viewerId={VIEWER.id}
                shelf="personal"
            >
                <MailView
                    page={{
                        accountId: "",
                        folderId: "",
                        role: "inbox",
                        labelId: "",
                        unreadOnly: false,
                        readOnly: false,
                        starredOnly: false,
                        importantOnly: false,
                        snoozedOnly: false,
                        withAttachments: false,
                        category: "",
                        sort: DEFAULT_MAIL_SORT,
                        query: ""
                    }}
                    openThreadId={open ? OPEN_THREAD_ID : ""}
                    categorised
                    preferences={MAIL_PREF_DEFAULTS}
                    fixedFilter=""
                    context={{
                        ...MAIL_VIEWS.inbox!.context,
                        title: label(ctx.locale, "mail.views.inbox.title"),
                        emptyTitle: label(ctx.locale, "mail.views.inbox.emptyTitle"),
                        emptyBody: label(ctx.locale, "mail.views.inbox.emptyBody")
                    }}
                />
            </MailShell>
        </Chrome>
    );
}

/** What the list and an open conversation are both asked for: the list hovers
 *  ahead of a click by fetching its first conversation. */
function mailApi(ctx: SceneContext) {
    return {
        "GET /api/mail/threads": () => ({ threads: mailThreads(ctx), cursor: "" }),
        "GET /api/mail/thread/:id": () => openThread(ctx),
        "GET /api/mail/message/:id": () => openedMessage(ctx),
        // Opening the conversation read its newest message; the rail is asked
        // again and counts one fewer.
        "GET /api/mail/rail": () => ({
            accounts: mailAccounts(ctx),
            folders: mailFolders(true),
            unread: mailUnread(true)
        })
    };
}

export const mail = defineScene({
    id: "mail",
    path: "/mail",
    api: mailApi,
    actions: () => ({ actOnAction: () => ({ done: 1 }) }),
    render: (ctx) => <Inbox ctx={ctx} open={false} />
});

export const mailThread = defineScene({
    id: "mail-thread",
    path: `/mail?open=${OPEN_THREAD_ID}`,
    api: mailApi,
    actions: () => ({ actOnAction: () => ({ done: 1 }) }),
    render: (ctx) => <Inbox ctx={ctx} open />
});
