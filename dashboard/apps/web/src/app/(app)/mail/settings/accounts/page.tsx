/**
 * The mailboxes somebody has connected, and the way to connect another.
 *
 * The screen that decides whether this app gets used. Everything about it is
 * arranged so the ordinary case - a Gmail or an Outlook address - is one button
 * and no typing, and the unusual case - a company's own server - is a form that
 * has already been filled in with the right answers.
 *
 * The linked accounts are read here rather than in the dialog so the dialog can
 * say, before anything is typed, which of them is ready to be used for mail and
 * which was linked for something else and has to be authorized again.
 */

import { prisma } from "@polaris/db";
import { AccountsView } from "./accounts-view";
import { requirePermission } from "@/lib/session";
import { listAccountViews } from "@/lib/mailbox/accounts";
import { grantsMailAccess } from "@/lib/mailbox/credentials";
import { getIntegrationState } from "@/lib/integration-service";

export const dynamic = "force-dynamic";

export default async function MailAccountsPage({
    searchParams
}: {
    searchParams: Promise<{ connection?: string; provider?: string }>;
}) {
    const user = await requirePermission("mail.use");
    const params = await searchParams;

    const [accounts, links, google, microsoft] = await Promise.all([
        listAccountViews(user.id),
        prisma.userConnection.findMany({
            where: { userId: user.id, provider: { in: ["google", "microsoft"] } },
            select: { id: true, provider: true, label: true, scope: true },
            orderBy: { linkedAt: "desc" }
        }),
        // Whether the operator has connected the application at all. Without it
        // the button cannot work, and saying so is more use than a screen that
        // sends somebody to a consent page that will not load.
        getIntegrationState("google"),
        getIntegrationState("microsoft")
    ]);

    return (
        <AccountsView
            accounts={accounts}
            links={links.map((link) => ({
                id: link.id,
                provider: link.provider,
                label: link.label,
                readyForMail: grantsMailAccess(link.provider, link.scope)
            }))}
            googleReady={Boolean(google?.enabled && google.hasSecret)}
            microsoftReady={Boolean(microsoft?.enabled && microsoft.hasSecret)}
            outcome={params.connection ?? ""}
            outcomeProvider={params.provider ?? ""}
        />
    );
}
