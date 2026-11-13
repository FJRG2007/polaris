/**
 * Minting a key (/account/api-keys/new).
 *
 * Its own address rather than a dialog over the list: what a key may do is the
 * whole of the decision, and it wants sections, room, and somewhere to come back
 * to. The scope list is built from what this user actually holds, so a key can
 * never be created with more reach than its owner - and the server checks that
 * again when the form is submitted.
 */

import { KeyForm } from "../key-form";
import { mayJoin } from "@/lib/vpn/service";
import { NewKeyKind } from "../new-key-kind";
import { Messages } from "@/components/i18n/messages";
import { requireUser } from "@/lib/session";
import { listAccessGroups, scopesAvailableTo } from "@polaris/auth";

export const dynamic = "force-dynamic";

export default async function NewApiKeyPage() {
    const user = await requireUser();
    // A VPN device key is offered on the same decision that lets the person
    // join the VPN, and checked again when it is made.
    const [groups, scopes, vpn] = await Promise.all([
        listAccessGroups(user.id),
        scopesAvailableTo(user.id, user.isAdmin),
        mayJoin(user).catch(() => false)
    ]);

    return (
        <Messages namespaces={["vpn"]}>
            <NewKeyKind vpn={vpn}>
                <KeyForm groups={groups} availableScopes={scopes} editing={null} />
            </NewKeyKind>
        </Messages>
    );
}
