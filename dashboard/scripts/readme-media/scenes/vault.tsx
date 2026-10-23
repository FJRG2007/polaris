/** Vault: the password manager, open on a login with its one-time code. */

import { once } from "../runtime/interact";
import { tourScene } from "../runtime/tour";
import { Chrome } from "../runtime/chrome";
import { VIEWER } from "../fixtures/people";
import { defineScene } from "../runtime/scene";
import { VaultApp } from "@/app/(app)/vault/vault-app";
import { SendsView } from "@/app/(app)/vault/sends/sends-view";
import { VaultGate, VaultSessionProvider } from "@/app/(app)/vault/vault-session";
import {
    OPEN_ITEM_NAME,
    holdVaultKey,
    vaultContents,
    vaultList,
    vaultState
} from "../fixtures/vault";

const vaultStill = defineScene({
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

/** Sends: something handed out of the vault to somebody who has no vault. */
export const vaultSends = defineScene({
    id: "vault-sends",
    path: "/vault/sends",
    actions: (ctx) => ({
        vaultListAction: () => vaultList(ctx),
        vaultContentsAction: () => vaultContents(ctx)
    }),
    render: () => {
        holdVaultKey();
        return (
            <Chrome>
                <VaultSessionProvider state={vaultState()} name={VIEWER.name}>
                    <VaultGate>
                        <SendsView />
                    </VaultGate>
                </VaultSessionProvider>
            </Chrome>
        );
    }
});

/**
 * Open the login. On a phone the list and the login stack in one column, so
 * the login's card is brought up the way a thumb scrolls to it.
 */
async function openOnPhone(ctx: Parameters<NonNullable<typeof vaultStill.prepare>>[0]) {
    await vaultStill.prepare?.(ctx);
    if (window.matchMedia("(min-width: 1024px)").matches) return;
    const name = OPEN_ITEM_NAME(ctx);
    await once(() => {
        const title = [...document.querySelectorAll("h2")].find(
            (heading) => heading.textContent === name
        );
        if (!title) throw new Error("the login did not open");
        (title.closest("[class*='rounded']") ?? title).scrollIntoView({ block: "start" });
    });
}

/** The vault, a login opened with its one-time code, then what was sent out of it. */
export const vault = tourScene(
    [{ ...vaultStill, prepare: undefined }, vaultSends],
    [{ hold: 1500 }, { run: (ctx) => openOnPhone(ctx), hold: 3000 }, { view: 1, hold: 2600 }]
);
