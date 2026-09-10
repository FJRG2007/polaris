"use client";

/**
 * The keys backups are sealed under.
 *
 * Every copy that leaves what it protects is encrypted with this account's backup
 * key. The key lives in this instance's database, so the recovery key is what opens
 * the copies once that database is gone - it is offered here to be kept somewhere
 * else, and a recovery key from another Polaris can be added to open its copies.
 */

import { useCallback, useEffect, useState } from "react";
import type { BackupKeyView } from "@/lib/backups/keyring";
import { KeyRound, Loader2, RefreshCw } from "lucide-react";
import { useDisplayFormat } from "@/components/display-format";
import {
    addRecoveryKeyAction,
    listBackupKeysAction,
    revealRecoveryKeyAction,
    rotateBackupKeyAction
} from "./actions";
import {
    Badge,
    Button,
    Card,
    CardBody,
    ConfirmDeleteDialog,
    CopyButton,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Skeleton
} from "@polaris/ui";

const RECOVERY_SHAPE = /^polaris-backup-key:[0-9a-f-]{36}:[A-Za-z0-9_-]{43}$/;

export function KeysPanel() {
    const format = useDisplayFormat();
    const [keys, setKeys] = useState<BackupKeyView[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [rotating, setRotating] = useState(false);
    const [rotatePending, setRotatePending] = useState(false);
    const [revealed, setRevealed] = useState<{ id: string; recoveryKey: string } | null>(null);
    const [revealing, setRevealing] = useState<string | null>(null);
    const [pasted, setPasted] = useState("");
    const [adding, setAdding] = useState(false);
    const [note, setNote] = useState<string | null>(null);

    const load = useCallback(async () => {
        const result = await listBackupKeysAction();
        if (result.error !== undefined) {
            setError(result.error);
            setKeys([]);
        } else {
            setKeys(result.keys);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    async function reveal(id: string) {
        setRevealing(id);
        setError(null);
        const result = await revealRecoveryKeyAction(id);
        setRevealing(null);
        if (result.error !== undefined) setError(result.error);
        else setRevealed({ id, recoveryKey: result.recoveryKey });
    }

    async function rotate() {
        setRotatePending(true);
        const result = await rotateBackupKeyAction();
        setRotatePending(false);
        if (result.error !== undefined) {
            setError(result.error);
            return;
        }
        setRotating(false);
        setNote("New copies are sealed under the new key. Keep its recovery key too.");
        await load();
    }

    async function add() {
        setAdding(true);
        setError(null);
        const result = await addRecoveryKeyAction(pasted);
        setAdding(false);
        if (result.error !== undefined) {
            setError(result.error);
            return;
        }
        setPasted("");
        setNote(result.added ? "Added. Copies sealed with it now open here." : "That key was already here.");
        await load();
    }

    const trimmed = pasted.trim();
    const pastedProblem = trimmed && !RECOVERY_SHAPE.test(trimmed) ? "That does not look like a recovery key" : null;

    return (
        <div className="flex flex-col gap-3">
            <Card>
                <CardBody className="flex flex-col gap-3 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <p className="max-w-prose text-muted-foreground">
                            Copies are encrypted before they leave, with this account&apos;s backup key. Keep each
                            key&apos;s recovery key somewhere other than this Polaris: without it, the copies cannot
                            be opened once this Polaris is gone.
                        </p>
                        <Button size="sm" variant="secondary" onClick={() => setRotating(true)} disabled={keys === null}>
                            <RefreshCw className="size-4" /> New key
                        </Button>
                    </div>
                    {keys === null ? (
                        <div className="flex flex-col gap-2">
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                        </div>
                    ) : keys.length === 0 ? (
                        <p className="text-muted-foreground">No key yet. One is made with the first backup.</p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                            {keys.map((key) => (
                                <li key={key.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                                    <KeyRound className="size-4 text-muted-foreground" />
                                    <code className="text-xs">{key.id.slice(0, 8)}</code>
                                    {key.retiredAt ? (
                                        <Badge variant="neutral">Opens old copies</Badge>
                                    ) : (
                                        <Badge variant="success">Sealing new copies</Badge>
                                    )}
                                    <span className="text-xs text-muted-foreground">
                                        Made {format.date(key.createdAt)} - {key.copies}{" "}
                                        {key.copies === 1 ? "copy" : "copies"}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="ml-auto"
                                        disabled={revealing !== null}
                                        onClick={() => void reveal(key.id)}
                                    >
                                        {revealing === key.id && <Loader2 className="size-4 animate-spin" />} Recovery
                                        key
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-2 text-sm">
                    <label className="flex flex-col gap-1">
                        <span className="font-medium">Add a recovery key</span>
                        <span className="text-xs text-muted-foreground">
                            From another Polaris, to open the copies it sealed.
                        </span>
                        <div className="flex flex-wrap gap-2">
                            <Input
                                value={pasted}
                                onChange={(event) => setPasted(event.target.value)}
                                placeholder="polaris-backup-key:..."
                                autoComplete="off"
                                spellCheck={false}
                                className="min-w-0 flex-1 font-mono text-xs"
                            />
                            <Button
                                size="sm"
                                onClick={() => void add()}
                                disabled={adding || !trimmed || pastedProblem !== null}
                            >
                                {adding && <Loader2 className="size-4 animate-spin" />} Add
                            </Button>
                        </div>
                    </label>
                    {pastedProblem && <p className="text-xs text-danger">{pastedProblem}</p>}
                </CardBody>
            </Card>

            {error && <p className="text-sm text-danger">{error}</p>}
            {note && <p className="text-xs text-muted-foreground">{note}</p>}

            <ConfirmDeleteDialog
                open={rotating}
                onOpenChange={setRotating}
                name="backup key"
                kind="key"
                requireTyping={false}
                title="Start a new backup key?"
                question="New copies are sealed under a new key. Copies already taken keep opening with the key they were sealed under."
                confirmLabel="New key"
                pending={rotatePending}
                onConfirm={() => void rotate()}
            />

            <Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Recovery key</DialogTitle>
                        <DialogDescription>
                            Opens every copy this key sealed. Keep it in a password manager, not on this machine.
                        </DialogDescription>
                    </DialogHeader>
                    {revealed && (
                        <div className="flex items-center gap-2 rounded-md border border-border p-2">
                            <code className="min-w-0 flex-1 break-all text-xs">{revealed.recoveryKey}</code>
                            <CopyButton value={revealed.recoveryKey} label="Copy the recovery key" />
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}
