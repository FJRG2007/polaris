"use client";

/**
 * Bringing a vault in from somewhere else.
 *
 * The reading is in `lib/vault/portability.ts`; this is the screen around it.
 * What matters here is the order of operations: the file is read in this
 * browser, its folders are made first so the items have somewhere to land, and
 * every item is encrypted here before it is sent, one at a time.
 *
 * One at a time is slower than one big request and it is the right trade: the
 * file holds passwords in the clear, and it should not be handed to a server
 * that has spent this whole feature being unable to read them.
 */

import { useState } from "react";
import { Loader2, Upload } from "lucide-react";
import * as vaultCrypto from "@/lib/vault/crypto";
import { readImportFile } from "@/lib/vault/portability";
import { Card, CardBody, CardHeader, CardTitle, Input } from "@polaris/ui";
import { decryptFolders, encryptItem, type VaultItem } from "../vault-model";
import { saveFolderAction, saveItemAction, vaultContentsAction } from "../vault-actions";

export function VaultImport({ vaultKey }: { vaultKey: vaultCrypto.SymmetricKey | null }) {
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);

    async function onFile(file: File): Promise<void> {
        if (!vaultKey) {
            setError("Your vault is locked.");
            return;
        }
        setError(null);
        setDone(null);

        let read: { items: VaultItem[]; folders: string[]; itemFolder: number[] };
        try {
            read = readImportFile(file.name, await file.text());
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "That file could not be read.");
            return;
        }
        if (read.items.length === 0) {
            setError("There was nothing in that file.");
            return;
        }

        setProgress({ done: 0, total: read.items.length });

        // Folders first: an item that names one has to have somewhere to land,
        // and a name that already exists is reused rather than duplicated. The
        // matching has to happen here because the names are encrypted - the
        // server sees ciphertext and cannot tell two "Work" folders apart.
        const existing = await decryptFolders((await vaultContentsAction()).folders, vaultKey);
        const byName = new Map(existing.map((folder) => [folder.name, folder.id]));
        const folderIds: (string | null)[] = [];
        for (const name of read.folders) {
            const known = byName.get(name);
            if (known) {
                folderIds.push(known);
                continue;
            }
            const result = await saveFolderAction(
                null,
                await vaultCrypto.encrypt(name, vaultKey)
            );
            const id = typeof result.folder?.id === "string" ? result.folder.id : null;
            if (id) byName.set(name, id);
            folderIds.push(id);
        }

        let failed = 0;
        for (const [index, item] of read.items.entries()) {
            const at = read.itemFolder[index] ?? -1;
            item.folderId = at >= 0 ? (folderIds[at] ?? null) : null;
            const result = await saveItemAction(null, await encryptItem(item, vaultKey));
            if (result.error) failed += 1;
            setProgress({ done: index + 1, total: read.items.length });
        }
        setProgress(null);
        setDone(
            failed === 0
                ? `Brought in ${read.items.length} items.`
                : `Brought in ${read.items.length - failed} items; ${failed} could not be saved.`
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Import</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                    A Bitwarden JSON export, a KeePass XML export, or the CSV most managers and
                    browsers write. The file is read here and every item is encrypted before it is
                    sent.
                </p>
                <Input
                    type="file"
                    accept=".json,.csv,.xml,text/csv,application/json,application/xml,text/xml"
                    disabled={progress !== null}
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void onFile(file);
                        event.target.value = "";
                    }}
                    aria-label="The file to import"
                />
                {progress ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        {progress.done} of {progress.total}...
                    </p>
                ) : null}
                {done ? (
                    <p className="flex items-center gap-2 text-sm text-success">
                        <Upload className="size-4" />
                        {done}
                    </p>
                ) : null}
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <p className="text-xs text-muted-foreground">
                    A KeePass <code>.kdbx</code> is the database itself rather than an export. In
                    KeePass, use File &gt; Export and pick KeePass XML.
                </p>
            </CardBody>
        </Card>
    );
}
