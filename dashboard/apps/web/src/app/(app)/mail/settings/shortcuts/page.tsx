/**
 * Mail's keyboard, and moving a shortcut to another key.
 *
 * The same screen as Account > Keyboard shortcuts, opened on Mail: every app's
 * keys live in one table now, so there is one place that moves them.
 *
 * About the person rather than a mailbox, like General, so it is open before
 * there is a mailbox at all.
 */

import { requirePermission } from "@/lib/session";
import { ShortcutSettings } from "@/components/shortcuts/shortcut-settings";

export const dynamic = "force-dynamic";

export default async function MailShortcutsPage() {
    await requirePermission("mail.use");
    return <ShortcutSettings app="mail" />;
}
