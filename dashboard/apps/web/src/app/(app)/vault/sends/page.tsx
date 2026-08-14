/**
 * Sends (/vault/sends).
 */

import { SendsView } from "./sends-view";
import { requirePermission } from "@/lib/session";
import { vaultStateAction } from "../vault-actions";

export const dynamic = "force-dynamic";

export default async function VaultSendsPage() {
    await requirePermission("vault.use");
    return <SendsView state={await vaultStateAction()} />;
}
