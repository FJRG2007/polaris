"use client";

/**
 * Handing one item to an organization.
 *
 * One way on purpose. The item is re-encrypted here under the organization's
 * key and its personal copy is replaced, so from that moment it belongs to
 * whoever is in the collection - and taking it back would mean re-encrypting it
 * under a personal key while everybody who already synced it still has the old
 * one. Bitwarden's clients make the same call, and it is the honest one.
 */

import { useEffect, useState } from "react";
import { Loader2, Share2 } from "lucide-react";
import * as vaultCrypto from "@/lib/vault/crypto";
import { useVaultSession } from "./vault-session";
import { encryptItem, type VaultItem } from "./vault-model";
import { shareItemAction, vaultCollectionsAction } from "./share-actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Select
} from "@polaris/ui";

interface CollectionRow {
    id: string;
    name: string;
}

export function ShareDialog({
    item,
    onClose,
    onShared
}: {
    /** Null when shut. Always a personal item; a shared one has nowhere to go. */
    item: VaultItem | null;
    onClose: () => void;
    onShared: () => Promise<void>;
}) {
    const { organizations, orgKeys } = useVaultSession();
    // Only the organizations whose key this account actually holds: sharing into
    // one it has only been invited to would produce ciphertext it cannot read.
    const usable = organizations.filter(
        (org) => org.vaultOrgId !== null && orgKeys.has(org.vaultOrgId)
    );
    const [orgId, setOrgId] = useState("");
    const [collections, setCollections] = useState<CollectionRow[]>([]);
    const [collectionId, setCollectionId] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!item) return;
        setOrgId(usable[0]?.organizationId ?? "");
        setError(null);
        // Only when the dialog opens: reacting to `usable` would reset the
        // picker under somebody mid-choice.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [item]);

    useEffect(() => {
        if (!orgId) {
            setCollections([]);
            return;
        }
        const org = usable.find((entry) => entry.organizationId === orgId);
        const key = org?.vaultOrgId ? orgKeys.get(org.vaultOrgId) : undefined;
        if (!key) return;
        let cancelled = false;
        void (async () => {
            const result = await vaultCollectionsAction(orgId);
            if (cancelled) return;
            if (result.error) {
                setError(result.error);
                setCollections([]);
                return;
            }
            const opened: CollectionRow[] = [];
            for (const raw of result.collections ?? []) {
                opened.push({
                    id: String(raw.id ?? ""),
                    // Encrypted under the organization's key, like everything
                    // else it owns.
                    name: (await vaultCrypto.decrypt(String(raw.name ?? ""), key)) ?? "Untitled"
                });
            }
            setCollections(opened);
            setCollectionId(opened[0]?.id ?? "");
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [orgId, orgKeys]);

    async function onShare(): Promise<void> {
        if (!item || !collectionId) return;
        const org = usable.find((entry) => entry.organizationId === orgId);
        const key = org?.vaultOrgId ? orgKeys.get(org.vaultOrgId) : undefined;
        if (!key || !org?.vaultOrgId) {
            setError("You do not hold that organization's key.");
            return;
        }
        setPending(true);
        setError(null);
        const body = await encryptItem({ ...item, organizationId: org.vaultOrgId }, key);
        const result = await shareItemAction(item.id, body, [collectionId]);
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        await onShared();
        onClose();
    }

    return (
        <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Share &quot;{item?.name}&quot;</DialogTitle>
                    <DialogDescription>
                        It is re-encrypted here under the organization&apos;s key. Everybody in the
                        collection will be able to read it, and it stops being yours alone.
                    </DialogDescription>
                </DialogHeader>

                {usable.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        You are not in a shared vault yet. One has to be set up for an
                        organization, and somebody already in it has to let you in.
                    </p>
                ) : (
                    <div className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Organization
                            <Select
                                value={orgId}
                                onValueChange={setOrgId}
                                aria-label="Organization"
                                options={usable.map((org) => ({
                                    value: org.organizationId,
                                    label: org.name
                                }))}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Collection
                            <Select
                                value={collectionId}
                                onValueChange={setCollectionId}
                                aria-label="Collection"
                                placeholder="No collections here yet"
                                options={collections.map((collection) => ({
                                    value: collection.id,
                                    label: collection.name
                                }))}
                            />
                        </label>
                    </div>
                )}

                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <DialogFooter>
                    <Button type="button" variant="secondary" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        onClick={onShare}
                        disabled={pending || !collectionId || usable.length === 0}
                    >
                        {pending ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Share2 className="size-4" />
                        )}
                        Share it
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
