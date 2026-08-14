/**
 * Vault settings (/vault/settings).
 *
 * Behind the same gate as every other vault screen: exporting decrypts here and
 * changing the master password re-wraps the key here, so both need the vault
 * open - and it already is, from wherever it was unlocked.
 */

import { VaultGate } from "../vault-session";
import { VaultSettings } from "./vault-settings";

export const dynamic = "force-dynamic";

export default function VaultSettingsPage() {
    return (
        <VaultGate>
            <VaultSettings />
        </VaultGate>
    );
}
