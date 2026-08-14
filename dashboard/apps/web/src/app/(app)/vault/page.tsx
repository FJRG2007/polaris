/**
 * The vault (/vault).
 *
 * The server's whole job here is to say whether there is a vault and hand over
 * the wrapped key. Everything after that happens in the browser, because
 * everything after that needs the master password.
 */

import { VaultApp } from "./vault-app";
import { requirePermission } from "@/lib/session";
import { vaultStateAction } from "./vault-actions";

export const dynamic = "force-dynamic";

export default async function VaultPage() {
    const user = await requirePermission("vault.use");
    const state = await vaultStateAction();
    return <VaultApp state={state} name={user.name} />;
}
