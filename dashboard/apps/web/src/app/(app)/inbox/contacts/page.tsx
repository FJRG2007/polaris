/**
 * Contacts: the messaging CRM. One entry per person with every platform handle
 * they can be reached on, so an operator picks a person (not a raw number) when
 * starting a chat and sees them unified across WhatsApp, Telegram and Discord.
 */

import { requireUser } from "@/lib/session";
import { listContacts } from "@/lib/messaging-service";
import { ContactsView } from "./contacts-view";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
    const user = await requireUser();
    const contacts = await listContacts(user.id);
    return <ContactsView initialContacts={contacts} />;
}
