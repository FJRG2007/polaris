/**
 * Mail that arrived in an inbox, told to the automations listening for it.
 *
 * Only to automations run by the mailbox's own owner: a mailbox is personal,
 * and that is the check every Mail screen makes (`ownedAccount`).
 */

import * as core from "@polaris/core";
import { emitAppEvent } from "./app-events";

export interface ArrivedMail {
    readonly messageId: string;
    readonly account: { readonly id: string; readonly userId: string; readonly address: string };
    readonly from: readonly core.MailAddress[];
    readonly subject: string;
    readonly snippet: string;
}

export async function announceMail(mail: ArrivedMail): Promise<boolean> {
    const sender = mail.from[0];
    return emitAppEvent(
        "mail.received",
        {
            messageId: mail.messageId,
            accountId: mail.account.id,
            mailbox: mail.account.address.slice(0, 320),
            from: (sender?.address ?? "").slice(0, 320),
            fromName: (sender?.name ?? "").slice(0, 200),
            subject: mail.subject.slice(0, 500),
            snippet: mail.snippet.slice(0, 500)
        },
        {
            key: mail.messageId,
            mayReceive: async (runner) => runner.id === mail.account.userId
        }
    );
}
