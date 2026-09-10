/**
 * The mailboxes somebody has connected, and the way to connect another.
 *
 * The screen that decides whether this app gets used. Everything about it is
 * arranged so the ordinary case - a Gmail or an Outlook address - is one button
 * and no typing, and the unusual case - a company's own server - is a form that
 * has already been filled in.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { AccountsView } from "./accounts-view";
import { requirePermission } from "@/lib/session";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { listAccountViews } from "@/lib/mailbox/accounts";
import { mailConnectOptions } from "@/lib/mailbox/connect-options";
import { MailAccessError, ownedAccount } from "@/lib/mailbox/access";

export const dynamic = "force-dynamic";

/** The mailbox `?edit=` names: an id, or nothing. */
const EDIT_PARAM = z.string().uuid();

/** The shelf a named mailbox is on, when it is this person's. Anybody else's,
 *  or one that does not exist, is nothing - the same answer either way. */
async function shelfOf(userId: string, accountId: string): Promise<{ orgId: string | null } | null> {
    try {
        const account = await ownedAccount(userId, accountId);
        return { orgId: account.orgId };
    } catch (caught) {
        if (caught instanceof MailAccessError) return null;
        throw caught;
    }
}

export default async function MailAccountsPage({
    searchParams
}: {
    searchParams: Promise<{
        connection?: string;
        provider?: string;
        connect?: string;
        edit?: string;
    }>;
}) {
    const user = await requirePermission("mail.use");
    const params = await searchParams;
    const editNow = EDIT_PARAM.safeParse(params.edit).data ?? "";
    const [scoped, named] = await Promise.all([
        scopeOrgIdFor(user.id),
        editNow ? shelfOf(user.id, editNow) : null
    ]);
    const shelf = named ? named.orgId : scoped;
    const [accounts, options] = await Promise.all([
        listAccountViews(user.id, shelf),
        mailConnectOptions(user.id)
    ]);

    return (
        <AccountsView
            accounts={accounts}
            links={options.links}
            googleReady={options.googleReady}
            microsoftReady={options.microsoftReady}
            publicAddress={options.publicAddress}
            canSetDomain={user.isAdmin}
            outcome={params.connection ?? ""}
            outcomeProvider={params.provider ?? ""}
            // Sent here by a Write with nothing to write from: the dialog is
            // what they came for, so it is already open.
            connectNow={params.connect === "1"}
            // Sent here by the notice that a mailbox stopped accepting its
            // password. Only ever one of this person's own - the view looks it
            // up in the list it was given and opens nothing otherwise.
            editNow={editNow}
            moveShelf={
                shelf === scoped
                    ? null
                    : shelf
                      ? core.formatScope({ kind: "org", orgId: shelf })
                      : core.PERSONAL_SCOPE
            }
        />
    );
}
