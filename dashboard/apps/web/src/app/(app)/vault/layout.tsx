/**
 * Everything under /vault shares one unlocked vault.
 *
 * The wrapped key and the account's timeout are read once here rather than per
 * page, and the session that holds the opened key lives above the routes - which
 * is what stops the item list, Sends and settings from each asking for the
 * master password on the way in.
 */

import type { ReactNode } from "react";
import { requirePermission } from "@/lib/session";
import { vaultStateAction } from "./vault-actions";
import { VaultSessionProvider } from "./vault-session";

export const dynamic = "force-dynamic";

export default async function VaultLayout({ children }: { children: ReactNode }) {
    const user = await requirePermission("vault.use");
    const state = await vaultStateAction();
    return (
        <VaultSessionProvider state={state} name={user.name}>
            {children}
        </VaultSessionProvider>
    );
}
