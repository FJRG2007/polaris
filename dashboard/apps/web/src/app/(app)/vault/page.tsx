/**
 * The vault (/vault).
 *
 * The server's whole job here is to say whether there is a vault and hand over
 * the wrapped key, and the layout already did both. Everything after that
 * happens in the browser, because everything after that needs the master
 * password.
 */

import { VaultApp } from "./vault-app";
import { VaultGate } from "./vault-session";

export const dynamic = "force-dynamic";

export default function VaultPage() {
    return (
        <VaultGate>
            <VaultApp />
        </VaultGate>
    );
}
