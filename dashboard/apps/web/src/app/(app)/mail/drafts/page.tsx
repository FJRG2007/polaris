/**
 * Everything started and not sent.
 *
 * Its own route rather than a folder listing, because Polaris' drafts and the
 * Drafts folder on the mail server are not the same thing. The composer saves
 * here as somebody types and nothing has ever been appended to the server's
 * folder, so this screen listing that folder meant it was permanently empty
 * while every draft anybody wrote sat in the database with no way back to it.
 */

import { DraftsView } from "./drafts-view";
import { requirePermission } from "@/lib/session";
import { listDrafts } from "@/lib/mailbox/compose";

export const dynamic = "force-dynamic";

export default async function MailDraftsPage() {
    const user = await requirePermission("mail.use");
    return <DraftsView drafts={await listDrafts(user.id)} />;
}
