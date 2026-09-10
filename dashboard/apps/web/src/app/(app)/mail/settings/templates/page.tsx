/**
 * Message templates.
 *
 * About the person rather than one mailbox, like labels - a template can still
 * be tied to one of them, which is chosen on the template itself.
 */

import { TemplatesView } from "./templates-view";
import { requirePermission } from "@/lib/session";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { listTemplates } from "@/lib/mailbox/templates";
import { listAccountViews } from "@/lib/mailbox/accounts";

export const dynamic = "force-dynamic";

export default async function MailTemplatesPage() {
    const user = await requirePermission("mail.use");
    const [templates, accounts] = await Promise.all([
        listTemplates(user.id),
        listAccountViews(user.id, await scopeOrgIdFor(user.id))
    ]);
    return (
        <TemplatesView
            templates={templates}
            accounts={accounts.map((account) => ({
                id: account.id,
                label: account.label || account.address
            }))}
        />
    );
}
