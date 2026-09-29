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
import { useTranslations } from "@/components/i18n/i18n-provider";
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
    const t = useTranslations("vault");
    const tc = useTranslations("common");
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
        ...(item?.organizationId ? [{ value: PERSONAL, label: t("vaults.ownTitle") }] : []),
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
            setError(t("move.noKey"));
            return;
        }
        if (!toPersonal && !collectionId) {
            setError(t("errors.pickCollectionMove"));
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
                    <DialogTitle>{t("move.title", { name: item?.name ?? "" })}</DialogTitle>
                    <DialogDescription>
                        {t("move.intro")}
                    </DialogDescription>
                </DialogHeader>

                {targets.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {t("move.nowhere")}
                    </p>
                ) : (
                    <div className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            {t("vaults.picker")}
                            <Select
                                value={target}
                                onValueChange={setTarget}
                                aria-label={t("vaults.picker")}
                                options={targets}
                            />
                        </label>
                        {target === PERSONAL ? null : (
                            <label className="flex flex-col gap-1 text-sm">
                                {t("move.collection")}
                                <Select
                                    value={collectionId}
                                    onValueChange={setCollectionId}
                                    aria-label={t("move.collection")}
                                    placeholder={t("move.noCollections")}
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
                        {tc("actions.cancel")}
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
                        {t("move.moveIt")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
