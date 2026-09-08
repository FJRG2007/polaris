/**
 * How this person reads mail, as opposed to how one of their mailboxes is set
 * up.
 *
 * Every other screen here is per mailbox, and rightly: a work address and a
 * personal one want different signatures, different privacy, a different
 * out-of-office. The way somebody reads is not one of those. It was a set of
 * constants in the code until now, which is a decision taken for everybody by
 * whoever typed them.
 *
 * No mailbox is needed to have an opinion about any of it, so this screen is the
 * one under settings that does not turn somebody away for having none.
 */

import { GeneralView } from "./general-view";
import { requirePermission } from "@/lib/session";
import { readMailPreferences } from "@/lib/mailbox/prefs";

export const dynamic = "force-dynamic";

export default async function MailGeneralPage() {
    const user = await requirePermission("mail.use");
    return <GeneralView preferences={await readMailPreferences(user.id)} />;
}
