/** Vault: the password manager, open on a login with its one-time code. */

import { Chrome } from "../runtime/chrome";
import { VIEWER } from "../fixtures/people";
import { defineScene } from "../runtime/scene";
import { VaultApp } from "@/app/(app)/vault/vault-app";
import { VaultGate, VaultSessionProvider } from "@/app/(app)/vault/vault-session";
import { OPEN_ITEM_NAME, holdVaultKey, vaultContents, vaultList, vaultState } from "../fixtures/vault";

export const vault = defineScene({
    id: "vault",
    path: "/vault",
    actions: (ctx) => ({
        vaultListAction: () => vaultList(ctx),
        vaultContentsAction: () => vaultContents(ctx),
        itemUsesAction: () => []
    }),
    api: () => ({
        // The breach check's range lookup, answered with no match: the fixture
        // passwords are in no breach.
        "GET https://api.pwnedpasswords.com/range/:prefix": () => new Response("")
    }),
    render: () => {
        // Unlocked earlier in this tab, which is where a reader finds it.
        holdVaultKey();
        return (
            <Chrome>
                <VaultSessionProvider state={vaultState()} name={VIEWER.name}>
                    <VaultGate>
                        <VaultApp />
                    </VaultGate>
                </VaultSessionProvider>
            </Chrome>
        );
    },
    prepare: (ctx) => {
        const name = OPEN_ITEM_NAME(ctx);
        const row = [...document.querySelectorAll<HTMLButtonElement>("ul button")].find((button) =>
            button.textContent?.includes(name)
        );
        if (!row) throw new Error("no vault item to open");
        row.click();
    }
});
