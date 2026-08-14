/**
 * Sends (/vault/sends).
 */

import { SendsView } from "./sends-view";
import { VaultGate } from "../vault-session";

export const dynamic = "force-dynamic";

export default function VaultSendsPage() {
    return (
        <VaultGate>
            <SendsView />
        </VaultGate>
    );
}
