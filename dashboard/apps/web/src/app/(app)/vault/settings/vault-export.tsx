"use client";

/**
 * Taking a vault out.
 *
 * Deliberately unencrypted, and deliberately loud about it: the reason to
 * export is to get OUT - to another manager, to a printout in a safe - and a
 * file only this vault could open would not do that. It is written by the
 * browser and never touches the server.
 *
 * Three formats rather than one because "somewhere else" is not one place; the
 * writing lives in `lib/vault/portability.ts`.
 */

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import * as vaultCrypto from "@/lib/vault/crypto";
import { vaultContentsAction } from "../vault-actions";
import { decryptFolders, decryptItem, type VaultItem } from "../vault-model";
import { Button, Card, CardBody, CardHeader, CardTitle, Select } from "@polaris/ui";
import { EXPORT_FORMATS, writeExport, type ExportFormat } from "@/lib/vault/portability";

export function VaultExport({
    vaultKey,
    confirm
}: {
    vaultKey: vaultCrypto.SymmetricKey | null;
    /** The page's confirm dialog, so this warning looks like every other one. */
    confirm: (options: {
        title: string;
        description?: string;
        confirmLabel?: string;
        danger?: boolean;
    }) => Promise<boolean>;
}) {
    const [format, setFormat] = useState<ExportFormat>("json");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onExport(): Promise<void> {
        if (!vaultKey) {
            setError("Your vault is locked.");
            return;
        }
        const confirmed = await confirm({
            title: "Export everything, unencrypted?",
            description:
                "The file will hold every password in plain text. Put it somewhere you would put the passwords themselves, and delete it when you are done.",
            confirmLabel: "Export",
            danger: true
        });
        if (!confirmed) return;

        setPending(true);
        setError(null);
        try {
            const contents = await vaultContentsAction();
            const folders = await decryptFolders(contents.folders, vaultKey);
            const items: VaultItem[] = [];
            for (const raw of contents.ciphers) items.push(await decryptItem(raw, vaultKey));

            // The trash is not part of a vault somebody is moving; carrying it
            // would resurrect what they deleted in whatever they move to.
            const file = writeExport(
                format,
                items.filter((item) => !item.deleted),
                folders
            );
            const blob = new Blob([file.text], { type: file.type });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `polaris-vault-export.${file.extension}`;
            anchor.click();
            URL.revokeObjectURL(url);
        } finally {
            setPending(false);
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Export</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                    Every item, in the clear. That is what makes it portable, and what makes it
                    worth deleting once whatever you are moving to has read it.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        value={format}
                        onValueChange={(value) => setFormat(value as ExportFormat)}
                        options={EXPORT_FORMATS.map((entry) => ({
                            value: entry.value,
                            label: entry.label
                        }))}
                        aria-label="Export format"
                        className="min-w-0 flex-1"
                    />
                    <Button variant="secondary" onClick={onExport} disabled={pending}>
                        {pending ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Download className="size-4" />
                        )}
                        Export
                    </Button>
                </div>
                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
