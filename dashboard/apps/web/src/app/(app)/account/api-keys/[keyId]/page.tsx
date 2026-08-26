/**
 * Changing a key (/account/api-keys/<id>).
 *
 * The same page that mints one, filled in - which is the point of it having an
 * address at all: a key whose expiry or scopes were set wrongly is somewhere you
 * can go back to, rather than something to delete and re-issue.
 *
 * The key is read from this account's own list rather than by id alone, so a
 * URL naming somebody else's key is a page that does not exist. Never the
 * secret: there is nothing stored that could show it.
 */

import { KeyForm } from "../key-form";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { listAccessGroups, listApiKeys, scopesAvailableTo } from "@polaris/auth";

export const dynamic = "force-dynamic";

export default async function EditApiKeyPage({ params }: { params: Promise<{ keyId: string }> }) {
    const { keyId } = await params;
    const user = await requireUser();
    const [keys, groups, scopes] = await Promise.all([
        listApiKeys(user.id),
        listAccessGroups(user.id),
        scopesAvailableTo(user.id, user.isAdmin)
    ]);

    const editing = keys.find((key) => key.id === keyId);
    if (!editing) notFound();

    return <KeyForm groups={groups} availableScopes={scopes} editing={editing} />;
}
