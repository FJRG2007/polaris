/**
 * The out-of-office reply.
 *
 * Per mailbox, because being away from work is not being away from everything.
 */

import { AwayView } from "./away-view";
import { prisma } from "@polaris/db";
import { requirePermission } from "@/lib/session";
import { NoMailboxes } from "../empty-accounts";
import { listAccountViews } from "@/lib/mailbox/accounts";
import { scopeOrgIdFor } from "@/lib/workspace-scope";

export const dynamic = "force-dynamic";

export default async function MailAwayPage() {
    const user = await requirePermission("mail.use");
    const accounts = await listAccountViews(user.id, await scopeOrgIdFor(user.id));
    if (accounts.length === 0) return <NoMailboxes what="An away message" />;

    // The message bodies are not on the account view - nothing else needs them -
    // so they are read here for the form.
    const rows = await prisma.mailAccount.findMany({
        where: { userId: user.id },
        select: {
            id: true,
            vacationEnabled: true,
            vacationSubject: true,
            vacationBody: true,
            vacationStartsAt: true,
            vacationEndsAt: true,
            vacationRepeatDays: true
        }
    });

    return (
        <AwayView
            accounts={accounts}
            vacations={Object.fromEntries(
                rows.map((row) => [
                    row.id,
                    {
                        enabled: row.vacationEnabled,
                        subject: row.vacationSubject,
                        body: row.vacationBody,
                        startsAt: row.vacationStartsAt?.toISOString().slice(0, 10) ?? "",
                        endsAt: row.vacationEndsAt?.toISOString().slice(0, 10) ?? "",
                        repeatDays: row.vacationRepeatDays
                    }
                ])
            )}
        />
    );
}
