/**
 * Email & SMS (/admin/email): the senders Polaris sends mail and texts through,
 * and - for an administrator - which of them carries account mail.
 *
 * A sender belongs to whoever added it, the same as before it moved here from
 * the Inbox's channels page, so the lists are this account's own. The account
 * mail choice is deployment-wide and picks from every email sender there is.
 */

import { PageHeader } from "@polaris/ui";
import { requirePermission, sessionCan } from "@/lib/session";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { listEmailChannels } from "@/lib/mail-service";
import { getTranslations } from "@/lib/i18n/request";
import { listSmsSenders } from "@/lib/notifications/sms-service";
import { AccountMailView } from "./email-admin";
import { SmsSenderCard } from "./sms-sender-card";
import { EmailSendersView } from "./senders-view";

export const dynamic = "force-dynamic";

export default async function EmailPage() {
    const user = await requirePermission("inbox.read");
    const [t, canManage, senders, smsSenders, everyChannel, status] = await Promise.all([
        getTranslations("admin"),
        sessionCan(user, "inbox.manage"),
        listEmailChannels(user.id),
        listSmsSenders(user.id),
        user.isAdmin ? listEmailChannels() : Promise.resolve([]),
        user.isAdmin ? getAuthMailStatus() : Promise.resolve(null)
    ]);
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
            <PageHeader title={t("email.title")} description={t("email.description")} />
            <EmailSendersView initialSenders={senders} canManage={canManage} />
            <SmsSenderCard senders={smsSenders} canManage={canManage} />
            {status ? <AccountMailView channels={everyChannel} selectedId={status.channelId} /> : null}
        </div>
    );
}
