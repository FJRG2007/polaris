/**
 * Where a `mailto:` link lands (/mail/compose?url=mailto:...).
 *
 * The browser sends every "email us" link here once Polaris is registered as
 * its handler (Mail settings > General). The link is read on the server by the
 * same parser the tests pin - every address checked, anything that is not one
 * dropped - and the inbox is drawn with the composer opened over it, seeded
 * from what survived. A link that is not a mailto at all opens the inbox and
 * nothing else.
 */

import { MAIL_VIEWS } from "../views";
import * as core from "@polaris/core";
import { OpenFromLink } from "./open-from-link";
import { MailListPage, type MailSearchParams } from "../list-page";

export const dynamic = "force-dynamic";

export default async function MailComposePage({
    searchParams
}: {
    searchParams: Promise<{ url?: string }>;
}) {
    const { url } = await searchParams;
    const seed = url ? core.parseMailto(url) : null;
    return (
        <>
            <MailListPage
                route={MAIL_VIEWS.inbox!}
                searchParams={searchParams as MailSearchParams}
            />
            <OpenFromLink seed={seed} />
        </>
    );
}
