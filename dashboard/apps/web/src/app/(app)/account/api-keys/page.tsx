/**
 * API keys page (/account/api-keys): the personal access tokens a user issues to
 * themselves so a script can act on their behalf without their password. The
 * scope checkboxes are built from what this user actually holds, so a key can
 * never be created with more reach than its owner.
 */

import { listAccessGroups, listApiKeys, scopesAvailableTo } from "@polaris/auth";
import { requireUser } from "@/lib/session";
import { ApiKeysView } from "./api-keys-view";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
    const user = await requireUser();
    const [keys, groups, scopes] = await Promise.all([
        listApiKeys(user.id),
        listAccessGroups(user.id),
        scopesAvailableTo(user.id, user.isAdmin)
    ]);

    return (
        // Wider than the rest of the account screens, because this one is a
        // table: nine columns squeezed into a reading column is nine columns
        // nobody can compare.
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
            <div>
                <h1 className="text-[17px] font-semibold tracking-tight">API keys</h1>
                <p className="text-sm text-muted-foreground">
                    Credentials for scripts and integrations acting as you. Keep them somewhere
                    safe: anyone holding one can do what it allows, as you.
                </p>
            </div>
            <ApiKeysView keys={keys} groups={groups} availableScopes={scopes} />
        </div>
    );
}
