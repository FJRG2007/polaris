"use client";

/**
 * Moving one item to another vault.
 *
 * The item is re-encrypted here under the key of wherever it is going, and the
 * old ciphertext is replaced. That is the whole move: there is no row to
 * reassign, because which key opens it IS where it lives.
 *
 * Whoever already synced it keeps their copy - a key cannot be un-given - so
 * moving something out of a shared vault decides where it is kept from now on,
 * not where it has been. Bitwarden's clients make the same call for the same
 * reason, and it is the honest one.
 */

import { useEffect, useState } from "react";
import { moveItemAction } from "./share-actions";
import { Loader2, MoveRight } from "lucide-react";
import { useVaultSession } from "./vault-session";
import { encryptItem, type VaultItem } from "./vault-model";
import { useVaultCollections } from "./use-vault-collections";
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

/** The value the picker uses for "back to my own vault". */
const PERSONAL = "personal";

export function MoveDialog({
    item,
    onClose,
    onMoved
}: {
    /** Null when shut. */
    item: VaultItem | null;
    onClose: () => void;
    onMoved: () => Promise<void>;
}) {
    const { vaults, vaultKeys, key: personalKey } = useVaultSession();
    // Only vaults whose key this account actually holds: moving into one it has
    // only been invited to would produce ciphertext it cannot read.
    const usable = vaults.filter(
        (vault) => vault.vaultId !== null && vaultKeys.has(vault.vaultId)
    );
    const [target, setTarget] = useState(PERSONAL);
    const [collectionId, setCollectionId] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { collections, error: collectionsError } = useVaultCollections(
        target === PERSONAL ? null : target
    );

    // Where it is now is not somewhere to move it to.
    const targets = [
        ...(item?.organizationId ? [{ value: PERSONAL, label: "My own vault" }] : []),
        ...usable
            .filter((vault) => vault.vaultId !== item?.organizationId)
            .map((vault) => ({ value: vault.vaultId ?? "", label: vault.name }))
    ];

    useEffect(() => {
        if (!item) return;
        setTarget(targets[0]?.value ?? "");
        setError(null);
        // Only when the dialog opens: reacting to the list would reset the picker
        // under somebody mid-choice.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [item]);

    // Land on the first collection of whatever was picked, and never leave a
    // stale id from the vault before it selected.
    useEffect(() => {
        setCollectionId(collections[0]?.id ?? "");
    }, [collections]);

    async function onMove(): Promise<void> {
        if (!item || !target) return;
        const toPersonal = target === PERSONAL;
        const key = toPersonal ? personalKey : (vaultKeys.get(target) ?? null);
        if (!key) {
            setError("You do not hold the key for that vault.");
            return;
        }
        if (!toPersonal && !collectionId) {
            setError("Pick a collection to move it into.");
            return;
        }
        setPending(true);
        setError(null);
        const body = await encryptItem(
            { ...item, organizationId: toPersonal ? null : target },
            key
        );
        const result = await moveItemAction(item.id, body, toPersonal ? [] : [collectionId]);
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        await onMoved();
        onClose();
    }

    return (
        <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Move &quot;{item?.name}&quot;</DialogTitle>
                    <DialogDescription>
                        It is re-encrypted here under the key of wherever it goes. Everybody in that
                        vault will be able to read it, and anybody who already synced it keeps the
                        copy they have.
                    </DialogDescription>
                </DialogHeader>

                {targets.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        There is nowhere to move it. Make another vault, or ask somebody to let you
                        into theirs.
                    </p>
                ) : (
                    <div className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Vault
                            <Select
                                value={target}
                                onValueChange={setTarget}
                                aria-label="Vault"
                                options={targets}
                            />
                        </label>
                        {target === PERSONAL ? null : (
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
                        )}
                    </div>
                )}

                {error ?? collectionsError ? (
                    <p className="text-sm text-danger">{error ?? collectionsError}</p>
                ) : null}
                <DialogFooter>
                    <Button type="button" variant="secondary" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        onClick={onMove}
                        disabled={
                            pending ||
                            targets.length === 0 ||
                            (target !== PERSONAL && !collectionId)
                        }
                    >
                        {pending ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <MoveRight className="size-4" />
                        )}
                        Move it
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
