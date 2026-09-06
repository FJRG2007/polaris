/**
 * One of the merged views: starred, snoozed, drafts, sent, archive, spam, trash.
 *
 * A single route rather than seven files, because they differ only in how the
 * query is narrowed and what the empty state says - both of which are data.
 * Anything not in the table is a path somebody typed, and is a 404 rather than
 * an empty inbox pretending to be a real screen.
 */

import { notFound } from "next/navigation";
import { MAIL_VIEWS } from "../views";
import { MailListPage, type MailSearchParams } from "../list-page";

export const dynamic = "force-dynamic";

export default async function MailViewPage({
    params,
    searchParams
}: {
    params: Promise<{ view: string }>;
    searchParams: MailSearchParams;
}) {
    const { view } = await params;
    const route = MAIL_VIEWS[view];
    if (!route || view === "inbox") notFound();
    return <MailListPage route={route} searchParams={searchParams} />;
}
