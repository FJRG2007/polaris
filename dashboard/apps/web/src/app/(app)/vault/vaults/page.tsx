/**
 * Vaults (/vault/vaults).
 *
 * Behind the gate like every other vault screen: creating a vault and letting
 * somebody into one both need this browser to be holding an unlocked vault,
 * because both are key operations rather than requests.
 */

import { VaultsView } from "./vaults-view";
import { VaultGate } from "../vault-session";

export const dynamic = "force-dynamic";

export default function VaultsPage() {
    return (
        <VaultGate>
            <VaultsView />
        </VaultGate>
    );
}
