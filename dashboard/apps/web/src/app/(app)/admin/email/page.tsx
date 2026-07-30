/**
 * Account mail (/admin/email): which of the configured email channels Polaris
 * sends its account messages through.
 *
 * The channels themselves are added under Inbox > Channels, by whoever owns the
 * provider account; this page only nominates one of them. Keeping the two apart
 * means an operator who already set up a sender for something else does not have
 * to configure it a second time here.
 */

import { requireAdmin } from "@/lib/session";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { listEmailChannels } from "@/lib/mail-service";
import { AccountMailView } from "./email-admin";

export const dynamic = "force-dynamic";

export default async function AccountMailPage() {
    await requireAdmin();
    const [channels, status] = await Promise.all([listEmailChannels(), getAuthMailStatus()]);
    return <AccountMailView channels={channels} selectedId={status.channelId} />;
}
