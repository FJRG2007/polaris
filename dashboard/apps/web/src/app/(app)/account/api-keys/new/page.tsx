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
import { requireUser } from "@/lib/session";
import { listAccessGroups, scopesAvailableTo } from "@polaris/auth";

export const dynamic = "force-dynamic";

export default async function NewApiKeyPage() {
    const user = await requireUser();
    const [groups, scopes] = await Promise.all([
        listAccessGroups(user.id),
        scopesAvailableTo(user.id, user.isAdmin)
    ]);

    return <KeyForm groups={groups} availableScopes={scopes} editing={null} />;
}
