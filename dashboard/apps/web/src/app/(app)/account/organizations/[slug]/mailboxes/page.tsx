/**
 * The mailboxes this organization has handed out.
 *
 * A register, not an inbox. It says which addresses exist, who holds each one
 * and whether it is still connecting - and it can never say what is in one.
 * Reading a mailbox is being the person it belongs to, and no permission written
 * here or anywhere else changes that.
 */

import { MailboxesView } from "./mailboxes-view";
import { requireOrgPage } from "@/lib/orgs/page-access";
import { listOrgMembers } from "@/lib/orgs/org-service";
import { listOrgMailboxes } from "@/lib/mailbox/org-mailboxes";
import { mailConnectOptions } from "@/lib/mailbox/connect-options";

export const dynamic = "force-dynamic";

export default async function OrganizationMailboxesPage({
    params
}: {
    params: Promise<{ slug: string }>;
}) {
    const { slug } = await params;
    const { org, user } = await requireOrgPage(slug, "mail.manage");
    const [mailboxes, members, options] = await Promise.all([
        listOrgMailboxes(user.id, org.id),
        listOrgMembers(org.id, { id: user.id, isAdmin: user.isAdmin }),
        mailConnectOptions(user.id)
    ]);

    return (
        <MailboxesView
            orgId={org.id}
            orgSlug={org.slug}
            mailboxes={mailboxes}
            members={members.map((member) => ({ id: member.userId, name: member.name }))}
            links={options.links}
            googleReady={options.googleReady}
            microsoftReady={options.microsoftReady}
            publicAddress={options.publicAddress}
            canSetDomain={user.isAdmin}
        />
    );
}
