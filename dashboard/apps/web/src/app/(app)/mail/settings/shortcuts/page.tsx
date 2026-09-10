/**
 * Mail's keyboard, and moving a shortcut to another key.
 *
 * About the person rather than a mailbox, like General, so it is open before
 * there is a mailbox at all.
 */

import { ShortcutsView } from "./shortcuts-view";
import { requirePermission } from "@/lib/session";
import { readMailPreferences } from "@/lib/mailbox/prefs";

export const dynamic = "force-dynamic";

export default async function MailShortcutsPage() {
    const user = await requirePermission("mail.use");
    const preferences = await readMailPreferences(user.id);
    return <ShortcutsView keymap={preferences.keys} />;
}
