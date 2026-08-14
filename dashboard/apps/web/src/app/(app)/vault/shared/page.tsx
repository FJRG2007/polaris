/**
 * Shared vaults (/vault/shared).
 *
 * Behind the gate like every other vault screen: creating an organization's
 * vault and letting somebody into one both need this browser to be holding an
 * unlocked vault, because both are key operations rather than requests.
 */

import { SharedView } from "./shared-view";
import { VaultGate } from "../vault-session";

export const dynamic = "force-dynamic";

export default function VaultSharedPage() {
    return (
        <VaultGate>
            <SharedView />
        </VaultGate>
    );
}
