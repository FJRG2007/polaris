/**
 * Mail (/mail): one inbox holding every mailbox.
 *
 * The landing screen is deliberately the merged one rather than a mailbox
 * picker. Somebody with three mailboxes wants to know what has arrived, not
 * which of three places to look first, and each row says which mailbox it came
 * from by the colour down its left.
 */

import { MAIL_VIEWS } from "./views";
import { MailListPage, type MailSearchParams } from "./list-page";

export const dynamic = "force-dynamic";

export default function MailInboxPage({ searchParams }: { searchParams: MailSearchParams }) {
    return <MailListPage route={MAIL_VIEWS.inbox!} searchParams={searchParams} />;
}
