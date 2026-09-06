/**
 * Labels.
 *
 * The one way of grouping mail here that spans mailboxes: a folder belongs to
 * one server, and "Invoices" belongs to the person. So they are not per mailbox
 * the way everything else behind this screen is.
 */

import { LabelsView } from "./labels-view";
import { listLabels } from "@/lib/mailbox/labels";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function MailLabelsPage() {
    const user = await requirePermission("mail.use");
    return <LabelsView labels={await listLabels(user.id)} />;
}
