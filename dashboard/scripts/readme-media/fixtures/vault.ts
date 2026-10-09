/**
 * A vault with a few months in it: logins for the shop's services, a card, a
 * note, a deploy key. Sealed in the browser with the vault's real encryption,
 * under a key fixed for the capture, so the screen opens them exactly as it
 * opens a real vault.
 */

import * as core from "@polaris/core";
import { VIEWER, ago, id } from "./people";
import * as vaultCrypto from "@/lib/vault/crypto";
import type { SceneContext } from "../runtime/scene";
import type { VaultView } from "@/app/(app)/vault/share-actions";
import type { VaultState } from "@/app/(app)/vault/vault-actions";
import { emptyItem, encryptItem, type VaultItem } from "@/app/(app)/vault/vault-model";

/** The vault key of the capture: 64 fixed bytes, a fixture and nothing else. */
export const VAULT_KEY = vaultCrypto.symmetricKeyFromBytes(
    Uint8Array.from({ length: 64 }, (_, index) => index + 1)
);

/** Where the vault session keeps a held key in this tab (`vault-session.tsx`). */
const SESSION_KEY = "polaris.vault.session";

/** Leave the key where the vault session picks it up, as a reload would find it. */
export function holdVaultKey(): void {
    window.sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
            key: vaultCrypto.toBase64(vaultCrypto.symmetricKeyBytes(VAULT_KEY)),
            until: null
        })
    );
}

export function vaultState(): VaultState {
    return {
        exists: true,
        kdf: core.DEFAULT_KDF_SETTINGS,
        protectedKey: "fixture",
        privateKey: null,
        publicKey: null,
        email: VIEWER.email,
        unlockTimeout: core.VAULT_LOCK_ON_TAB_CLOSE
    };
}

export function vaultList(ctx: SceneContext): VaultView[] {
    return [
        {
            vaultId: null,
            organizationId: null,
            name: ctx.say("My vault", "Mi bóveda"),
            mine: true,
            mayAdminister: true,
            wrappedKey: null,
            confirmed: true,
            publicKey: null,
            memberId: null,
            account: true
        }
    ];
}

export const WORK_FOLDER = id("vault-folder", 1);
const HOME_FOLDER = id("vault-folder", 2);

/** The item the scene opens, by the name the list shows. */
export const OPEN_ITEM_NAME = (ctx: SceneContext): string =>
    ctx.say("Shop admin", "Admin de la tienda");

function login(
    n: number,
    name: string,
    username: string,
    uri: string,
    extra: { totp?: string; favorite?: boolean; folderId?: string | null } = {}
): VaultItem {
    const item = emptyItem(core.CIPHER_LOGIN);
    item.id = id("vault-item", n);
    item.name = name;
    item.login = {
        username,
        // A generated-looking password that belongs to nothing.
        password: `fixture-${n}-Kq7!vR2m`,
        totp: extra.totp ?? "",
        uris: [{ uri, match: null }]
    };
    item.favorite = extra.favorite ?? false;
    item.folderId = extra.folderId ?? WORK_FOLDER;
    return item;
}

function items(ctx: SceneContext): VaultItem[] {
    const card = emptyItem(core.CIPHER_CARD);
    card.id = id("vault-item", 20);
    card.name = ctx.say("Company card", "Tarjeta de empresa");
    card.folderId = WORK_FOLDER;
    // The network's published test number, not a card.
    card.card = {
        cardholderName: VIEWER.name,
        brand: "Visa",
        number: "4242424242424242",
        expMonth: "08",
        expYear: "2029",
        code: "123"
    };

    const note = emptyItem(core.CIPHER_SECURE_NOTE);
    note.id = id("vault-item", 21);
    note.name = ctx.say("Office Wi-Fi", "Wi-Fi de la oficina");
    note.notes = "SSID: example-office";
    note.folderId = HOME_FOLDER;

    const ssh = emptyItem(core.CIPHER_SSH_KEY);
    ssh.id = id("vault-item", 22);
    ssh.name = ctx.say("Deploy key", "Clave de despliegue");
    ssh.sshKey = {
        privateKey: "",
        publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureFixtureFixture deploy@example.com",
        keyFingerprint: "SHA256:fixture"
    };
    ssh.folderId = WORK_FOLDER;

    return [
        // A well-known demo secret, so the code on screen changes like a real one.
        login(1, OPEN_ITEM_NAME(ctx), VIEWER.email, "https://admin.shop.example.com", {
            totp: "JBSWY3DPEHPK3PXP",
            favorite: true
        }),
        login(2, "Postgres (production)", "storefront", "postgres://db.shop.example.com:5432"),
        login(
            3,
            ctx.say("Payments dashboard", "Panel de pagos"),
            "finance@example.com",
            "https://payments.example.com",
            { favorite: true }
        ),
        login(
            4,
            ctx.say("Domain registrar", "Registrador de dominios"),
            VIEWER.email,
            "https://registrar.example.com"
        ),
        login(5, ctx.say("Analytics", "Analítica"), VIEWER.email, "https://analytics.example.com"),
        login(6, ctx.say("Router", "Router"), "admin", "http://192.168.1.1", {
            folderId: HOME_FOLDER
        }),
        login(
            7,
            ctx.say("Streaming", "Streaming"),
            "alex.rivera@example.com",
            "https://tv.example.com",
            { folderId: HOME_FOLDER }
        ),
        card,
        note,
        ssh
    ];
}

/** What the server would hold: every field sealed, folders included. */
export async function vaultContents(ctx: SceneContext) {
    const ciphers = await Promise.all(
        items(ctx).map(async (item, index) => ({
            ...(await encryptItem(item, VAULT_KEY)),
            id: item.id,
            deletedDate: null,
            revisionDate: ago(ctx.now, 60 * 24 * (index + 2))
        }))
    );
    const folders = [
        { id: WORK_FOLDER, name: await vaultCrypto.encrypt(ctx.say("Work", "Trabajo"), VAULT_KEY) },
        { id: HOME_FOLDER, name: await vaultCrypto.encrypt(ctx.say("Home", "Casa"), VAULT_KEY) }
    ];
    return { ciphers, folders, sends: [] };
}
