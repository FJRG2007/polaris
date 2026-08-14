"use client";

/**
 * The collections of one vault, opened.
 *
 * Their names are encrypted under the vault's key like everything else it owns,
 * so every screen that lists them has to hold that key and decrypt them. This is
 * the one place that does it: three screens ask the same question - where can
 * this go, what is in here, what does this member reach - and a second copy of
 * the loop is a second place to forget which key opens which vault.
 */

import * as vaultCrypto from "@/lib/vault/crypto";
import { useVaultSession } from "./vault-session";
import { useCallback, useEffect, useState } from "react";
import { vaultCollectionsAction } from "./share-actions";

export interface VaultCollection {
    id: string;
    name: string;
}

export function useVaultCollections(vaultId: string | null): {
    collections: VaultCollection[];
    error: string | null;
    /** Ask again, after one is made or deleted. */
    reload: () => Promise<void>;
} {
    const { vaultKeys } = useVaultSession();
    const [collections, setCollections] = useState<VaultCollection[]>([]);
    const [error, setError] = useState<string | null>(null);
    const key = vaultId ? (vaultKeys.get(vaultId) ?? null) : null;

    const reload = useCallback(async () => {
        if (!vaultId || !key) {
            setCollections([]);
            return;
        }
        const result = await vaultCollectionsAction(vaultId);
        if (result.error) {
            setError(result.error);
            setCollections([]);
            return;
        }
        setError(null);
        const opened: VaultCollection[] = [];
        for (const raw of result.collections ?? []) {
            opened.push({
                id: String(raw.id ?? ""),
                name: (await vaultCrypto.decrypt(String(raw.name ?? ""), key)) ?? "Untitled"
            });
        }
        setCollections(opened.sort((left, right) => left.name.localeCompare(right.name)));
    }, [vaultId, key]);

    useEffect(() => {
        void reload();
    }, [reload]);

    return { collections, error, reload };
}
