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

export const dynamic = "force-dynamic";

export default async function OrganizationMailboxesPage({
    params
}: {
    params: Promise<{ slug: string }>;
}) {
    const { slug } = await params;
    const { org, user } = await requireOrgPage(slug, "mail.manage");
    const [mailboxes, members] = await Promise.all([
        listOrgMailboxes({ id: user.id, isAdmin: user.isAdmin }, org.id),
        listOrgMembers(org.id, { id: user.id, isAdmin: user.isAdmin })
    ]);

    // Nothing about authorized accounts is read here, and the dialog is told not
    // to offer them: the mailbox is created against its holder, so the only
    // authorization that could connect it is one only they can grant. What this
    // screen hands out takes a password.
    return (
        <MailboxesView
            orgId={org.id}
            orgSlug={org.slug}
            mailboxes={mailboxes}
            members={members.map((member) => ({ id: member.userId, name: member.name }))}
        />
    );
}
