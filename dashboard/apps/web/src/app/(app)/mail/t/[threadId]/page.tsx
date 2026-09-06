/**
 * A link to one conversation.
 *
 * The address anybody can be sent, and the one a browser keeps in its history.
 * It opens the merged inbox with that conversation open beside it rather than on
 * a page of its own, so arriving at a link leaves somebody where they can carry
 * on working instead of at a dead end with a back button.
 *
 * The conversation opens even when it is not on the first page of that list -
 * `MailListPage` looks it up on its own and refuses only when it is not this
 * person's.
 */

import { MAIL_VIEWS } from "@/app/(app)/mail/views";
import { MailListPage } from "@/app/(app)/mail/list-page";

export const dynamic = "force-dynamic";

export default async function MailThreadPage({
    params,
    searchParams
}: {
    params: Promise<{ threadId: string }>;
    searchParams: Promise<{ q?: string; before?: string }>;
}) {
    const { threadId } = await params;
    const rest = await searchParams;
    return (
        <MailListPage
            route={MAIL_VIEWS.inbox!}
            searchParams={Promise.resolve({ ...rest, open: threadId })}
        />
    );
}
