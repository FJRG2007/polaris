/**
 * The mailboxes somebody has connected, and the way to connect another.
 *
 * The screen that decides whether this app gets used. Everything about it is
 * arranged so the ordinary case - a Gmail or an Outlook address - is one button
 * and no typing, and the unusual case - a company's own server - is a form that
 * has already been filled in.
 */

import { AccountsView } from "./accounts-view";
import { requirePermission } from "@/lib/session";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { listAccountViews } from "@/lib/mailbox/accounts";
import { mailConnectOptions } from "@/lib/mailbox/connect-options";

export const dynamic = "force-dynamic";

export default async function MailAccountsPage({
    searchParams
}: {
    searchParams: Promise<{ connection?: string; provider?: string; connect?: string }>;
}) {
    const user = await requirePermission("mail.use");
    const params = await searchParams;
    const [accounts, options] = await Promise.all([
        listAccountViews(user.id, await scopeOrgIdFor(user.id)),
        mailConnectOptions(user.id)
    ]);

    return (
        <AccountsView
            accounts={accounts}
            links={options.links}
            googleReady={options.googleReady}
            microsoftReady={options.microsoftReady}
            publicAddress={options.publicAddress}
            canSetDomain={user.isAdmin}
            outcome={params.connection ?? ""}
            outcomeProvider={params.provider ?? ""}
            // Sent here by a Write with nothing to write from: the dialog is
            // what they came for, so it is already open.
            connectNow={params.connect === "1"}
        />
    );
}
