"use client";

/**
 * The unlocked vault, held once for every vault screen.
 *
 * Before this, each screen unlocked on its own: moving from the item list to
 * Sends to settings asked for the master password three times, which is not
 * security, it is a screen nobody uses. So the key is held here, above the
 * routes, and the question becomes how long it may be held rather than whether.
 *
 * WHERE IT IS HELD, exactly, because it matters:
 *
 *  - In this component's state, always. That alone survives moving between
 *    vault screens, and nothing else.
 *  - In `sessionStorage`, only when the account's setting allows it. That is
 *    what survives a reload and leaving the vault for another app. It is per
 *    tab and dies with the tab - never `localStorage`, which would survive
 *    closing the browser and put the key on disk.
 *
 * Anything running in this origin can read either one; a key in memory is not
 * hidden from script that is already on the page. What the setting buys is the
 * window: "as soon as I leave the vault" keeps it out of storage entirely, and
 * every other choice says how many idle minutes it may sit there.
 *
 * The deadline is stored beside the key rather than kept in a timer, because a
 * timer does not run while the tab is on another app - and that is exactly the
 * span the setting is about.
 */

import { forgetBreaches } from "@/lib/breach-cache";
import * as core from "@polaris/core";
import { VaultSetup } from "./vault-setup";
import { VaultUnlock } from "./vault-unlock";
import type { VaultState } from "./vault-actions";
import * as vaultCrypto from "@/lib/vault/crypto";
import { vaultListAction, type VaultView } from "./share-actions";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode
} from "react";

/** Where a held key lives in this tab. */
const STORAGE_KEY = "polaris.vault.session";

/** How often the held key is checked against its deadline. */
const SWEEP_MS = 10_000;

interface HeldSession {
    /** The 64 raw bytes of the vault key, base64. */
    key: string;
    /** When it stops being usable, or null for "until the tab closes". */
    until: number | null;
}

interface VaultSessionValue {
    state: VaultState;
    /** The account's name, which the setup screen checks a password against. */
    name: string;
    key: vaultCrypto.SymmetricKey | null;
    /** Take the key, from an unlock or from a vault that was just created. */
    hold: (key: vaultCrypto.SymmetricKey) => void;
    /** Drop the key. The reason, when there is one, is shown on the lock screen -
     *  a vault that locks itself without saying why reads as a fault. */
    lock: (reason?: string) => void;
    unlockTimeout: number;
    /** Every vault this account can see, and where it stands in each. */
    vaults: VaultView[];
    /** The vault keys this account actually holds, by vault id. Absent means
     *  invited but not yet vouched for - which reads nothing. */
    vaultKeys: ReadonlyMap<string, vaultCrypto.SymmetricKey>;
    /** This account's RSA private half, for unwrapping a key sent to it. */
    privateKey: Uint8Array | null;
    /** The key an item of a given owner is encrypted under, by the id the item
     *  itself carries - the vault's, or null for an item in this account's own. */
    keyFor: (vaultId: string | null) => vaultCrypto.SymmetricKey | null;
    /** Pick the vaults up again, after one is created, renamed or joined. */
    reloadVaults: () => Promise<void>;
    /** Why the vault locked, when something other than the deadline did it. */
    lockNotice: string | null;
}

const VaultSessionContext = createContext<VaultSessionValue | null>(null);

/** The vault session. Throws outside the provider, which is a wiring mistake. */
export function useVaultSession(): VaultSessionValue {
    const value = useContext(VaultSessionContext);
    if (!value) throw new Error("useVaultSession outside VaultSessionProvider");
    return value;
}

/** Read the held key, dropping it if its deadline has passed. */
function readHeld(): vaultCrypto.SymmetricKey | null {
    try {
        const raw = window.sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const held = JSON.parse(raw) as HeldSession;
        if (held.until !== null && held.until <= Date.now()) {
            window.sessionStorage.removeItem(STORAGE_KEY);
            return null;
        }
        return vaultCrypto.symmetricKeyFromBytes(vaultCrypto.fromBase64(held.key));
    } catch {
        // A value that will not parse is one no key can be read out of. Drop it
        // rather than leaving something unreadable behind forever.
        window.sessionStorage.removeItem(STORAGE_KEY);
        return null;
    }
}

export function VaultSessionProvider({
    state,
    name,
    children
}: {
    state: VaultState;
    /** The account's name, which vault setup uses for its password checks. */
    name: string;
    children: ReactNode;
}) {
    const timeout = state.unlockTimeout;
    const [key, setKey] = useState<vaultCrypto.SymmetricKey | null>(null);
    // Whether the first read of storage has happened. Until it has, this renders
    // as locked, and drawing the lock screen for the moment before a held key is
    // found would make every navigation flash it.
    const [restored, setRestored] = useState(timeout === core.VAULT_LOCK_IMMEDIATELY);
    const [vaults, setVaults] = useState<VaultView[]>([]);
    const [vaultKeys, setVaultKeys] = useState<Map<string, vaultCrypto.SymmetricKey>>(new Map());
    const [privateKey, setPrivateKey] = useState<Uint8Array | null>(null);
    const [lockNotice, setLockNotice] = useState<string | null>(null);
    const keyRef = useRef<vaultCrypto.SymmetricKey | null>(null);
    keyRef.current = key;

    /** Write the key and its deadline, or clear both. */
    const persist = useCallback(
        (value: vaultCrypto.SymmetricKey | null) => {
            if (timeout === core.VAULT_LOCK_IMMEDIATELY) return;
            if (!value) {
                window.sessionStorage.removeItem(STORAGE_KEY);
                return;
            }
            const held: HeldSession = {
                key: vaultCrypto.toBase64(vaultCrypto.symmetricKeyBytes(value)),
                until:
                    timeout === core.VAULT_LOCK_ON_TAB_CLOSE ? null : Date.now() + timeout * 60_000
            };
            window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(held));
        },
        [timeout]
    );

    const hold = useCallback(
        (value: vaultCrypto.SymmetricKey) => {
            setKey(value);
            setLockNotice(null);
            persist(value);
        },
        [persist]
    );

    const lock = useCallback((reason?: string) => {
        setKey(null);
        setVaultKeys(new Map());
        setPrivateKey(null);
        setLockNotice(reason ?? null);
        window.sessionStorage.removeItem(STORAGE_KEY);
        // The breach answers are keyed by sixteen bits of each password, which
        // is deliberately too little to be worth anything - but a locked vault
        // should leave nothing behind at all, and this is a removal rather than
        // a decision.
        forgetBreaches();
    }, []);

    /**
     * Work out which of the other vaults this account can actually read.
     *
     * Three steps, and each is a different kind of key: the account's own vault
     * key opens its RSA private half, the private half unwraps the vault key
     * somebody wrapped to it, and that key is what the items in that vault are
     * encrypted under. A membership with no wrapped key is somebody who has been
     * invited and not yet vouched for, and it reads nothing - which is the state
     * this whole arrangement exists to make possible.
     */
    const loadVaults = useCallback(
        async (withKey: vaultCrypto.SymmetricKey) => {
            const rows = await vaultListAction();
            setVaults(rows);

            const wrappedPrivate = state.privateKey;
            if (!wrappedPrivate) {
                setPrivateKey(null);
                setVaultKeys(new Map());
                return;
            }
            const opened = await vaultCrypto.decryptBytes(wrappedPrivate, withKey);
            setPrivateKey(opened);
            if (!opened) {
                setVaultKeys(new Map());
                return;
            }

            // Keyed by the VAULT's id, not the Polaris organization's: that is
            // what an item carries, and confusing the two produces a map that
            // never matches anything and a vault that appears empty.
            const keys = new Map<string, vaultCrypto.SymmetricKey>();
            for (const vault of rows) {
                if (!vault.confirmed || !vault.wrappedKey || !vault.vaultId) continue;
                const raw = await vaultCrypto.decryptRsa(vault.wrappedKey, opened);
                if (raw?.length === 64) {
                    keys.set(vault.vaultId, vaultCrypto.symmetricKeyFromBytes(raw));
                }
            }
            setVaultKeys(keys);
        },
        [state.privateKey]
    );

    const reloadVaults = useCallback(async () => {
        if (keyRef.current) await loadVaults(keyRef.current);
    }, [loadVaults]);

    useEffect(() => {
        if (key) void loadVaults(key);
    }, [key, loadVaults]);

    /** Which key opens an item: the account's own vault, or another one's. */
    const keyFor = useCallback(
        (vaultId: string | null) => (vaultId ? (vaultKeys.get(vaultId) ?? null) : key),
        [key, vaultKeys]
    );

    // Pick the key back up on mount, which is what makes a navigation or a
    // reload keep it. Storage is only ever read here.
    useEffect(() => {
        if (timeout === core.VAULT_LOCK_IMMEDIATELY) {
            window.sessionStorage.removeItem(STORAGE_KEY);
            setRestored(true);
            return;
        }
        setKey(readHeld());
        setRestored(true);
    }, [timeout]);

    // Using the vault pushes the deadline out; sitting on the screen doing
    // nothing does not. Pointer and key events are what "using it" means here,
    // and they are cheap enough to write through on every one because the value
    // is 100 bytes in this tab's own storage.
    useEffect(() => {
        if (!key || timeout <= 0) return;
        const onActivity = (): void => persist(keyRef.current);
        window.addEventListener("pointerdown", onActivity);
        window.addEventListener("keydown", onActivity);
        return () => {
            window.removeEventListener("pointerdown", onActivity);
            window.removeEventListener("keydown", onActivity);
        };
    }, [key, timeout, persist]);

    // And the other half: lock the screen that is sitting open when the deadline
    // passes, rather than waiting for the next navigation to notice.
    useEffect(() => {
        if (!key || timeout <= 0) return;
        const timer = window.setInterval(() => {
            if (!readHeld()) setKey(null);
        }, SWEEP_MS);
        return () => window.clearInterval(timer);
    }, [key, timeout]);

    const value = useMemo<VaultSessionValue>(
        () => ({
            state,
            name,
            key,
            hold,
            lock,
            unlockTimeout: timeout,
            vaults,
            vaultKeys,
            privateKey,
            keyFor,
            reloadVaults,
            lockNotice
        }),
        [
            state,
            name,
            key,
            hold,
            lock,
            timeout,
            vaults,
            vaultKeys,
            privateKey,
            keyFor,
            reloadVaults,
            lockNotice
        ]
    );

    return (
        <VaultSessionContext.Provider value={value}>
            {restored ? children : null}
        </VaultSessionContext.Provider>
    );
}

/**
 * A screen that needs the vault open.
 *
 * Wrapped rather than checked in each screen so the setup and lock screens are
 * written once, and so a new vault screen cannot forget to ask.
 */
export function VaultGate({ children }: { children: ReactNode }) {
    const { state, name, key, hold, lockNotice } = useVaultSession();
    if (!state.exists) return <VaultSetup email={state.email} name={name} onCreated={hold} />;
    if (!key) {
        return (
            <VaultUnlock
                email={state.email}
                kdf={state.kdf}
                protectedKey={state.protectedKey ?? ""}
                notice={lockNotice}
                onUnlocked={hold}
            />
        );
    }
    return <>{children}</>;
}
