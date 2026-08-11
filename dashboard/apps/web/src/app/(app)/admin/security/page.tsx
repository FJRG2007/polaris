/**
 * Management > Security: what this deployment demands of every account on it.
 *
 * Distinct from Account > Security, which is what one person demands of their own
 * account. The two do not overlap and neither can weaken the other: a person can
 * add protection here that the instance did not ask for, and cannot drop what it
 * did.
 *
 * Whether mail works is resolved on the server and handed down, because "accept
 * emailed codes" is a promise the deployment can only keep when it has a channel
 * to send from - and an administrator turning it on deserves to be told that now
 * rather than by a user who cannot finish signing in.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { SecurityAdmin } from "./security-admin";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { getInstanceSecurity } from "@/lib/instance-security";

export const dynamic = "force-dynamic";

export default async function AdminSecurityPage() {
    await requireAdmin();
    const [policy, mail] = await Promise.all([getInstanceSecurity(), getAuthMailStatus()]);

    return (
        <>
            <PageHeader
                title="Security"
                description="What every account on this Polaris has to carry before it can be used."
            />
            <SecurityAdmin policy={policy} mailReady={mail.channelId !== null} />
        </>
    );
}
