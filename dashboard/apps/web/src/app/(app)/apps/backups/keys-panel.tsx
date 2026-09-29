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
import { useTranslations } from "@/components/i18n/i18n-provider";
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
    const t = useTranslations("backups");
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
        setNote(t("keys.rotated"));
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
        setNote(result.added ? t("keys.added") : t("keys.already"));
        await load();
    }

    const trimmed = pasted.trim();
    const pastedProblem = trimmed && !RECOVERY_SHAPE.test(trimmed) ? t("keys.notAKey") : null;

    return (
        <div className="flex flex-col gap-3">
            <Card>
                <CardBody className="flex flex-col gap-3 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <p className="max-w-prose text-muted-foreground">
                            {t("keys.intro")}
                        </p>
                        <Button size="sm" variant="secondary" onClick={() => setRotating(true)} disabled={keys === null}>
                            <RefreshCw className="size-4" /> {t("keys.new")}
                        </Button>
                    </div>
                    {keys === null ? (
                        <div className="flex flex-col gap-2">
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                        </div>
                    ) : keys.length === 0 ? (
                        <p className="text-muted-foreground">{t("keys.none")}</p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                            {keys.map((key) => (
                                <li key={key.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                                    <KeyRound className="size-4 text-muted-foreground" />
                                    <code className="text-xs">{key.id.slice(0, 8)}</code>
                                    {key.retiredAt ? (
                                        <Badge variant="neutral">{t("keys.retired")}</Badge>
                                    ) : (
                                        <Badge variant="success">{t("keys.current")}</Badge>
                                    )}
                                    <span className="text-xs text-muted-foreground">
                                        {t("keys.made", { when: format.date(key.createdAt), count: key.copies })}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="ml-auto"
                                        disabled={revealing !== null}
                                        onClick={() => void reveal(key.id)}
                                    >
                                        {revealing === key.id && <Loader2 className="size-4 animate-spin" />}{" "}
                                        {t("keys.recovery")}
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
                        <span className="font-medium">{t("keys.addTitle")}</span>
                        <span className="text-xs text-muted-foreground">{t("keys.addHint")}</span>
                        <div className="flex flex-wrap gap-2">
                            <Input
                                value={pasted}
                                onChange={(event) => setPasted(event.target.value)}
                                placeholder="polaris-backup-key:..." // i18n-ignore the key's own format
                                autoComplete="off"
                                spellCheck={false}
                                className="min-w-0 flex-1 font-mono text-xs"
                            />
                            <Button
                                size="sm"
                                onClick={() => void add()}
                                disabled={adding || !trimmed || pastedProblem !== null}
                            >
                                {adding && <Loader2 className="size-4 animate-spin" />} {t("destinations.addShort")}
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
                name={t("keys.name")}
                kind={t("keys.kind")}
                requireTyping={false}
                title={t("keys.rotateTitle")}
                question={t("keys.rotateBody")}
                confirmLabel={t("keys.new")}
                pending={rotatePending}
                onConfirm={() => void rotate()}
            />

            <Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("keys.recoveryTitle")}</DialogTitle>
                        <DialogDescription>{t("keys.recoveryBody")}</DialogDescription>
                    </DialogHeader>
                    {revealed && (
                        <div className="flex items-center gap-2 rounded-md border border-border p-2">
                            <code className="min-w-0 flex-1 break-all text-xs">{revealed.recoveryKey}</code>
                            <CopyButton value={revealed.recoveryKey} label={t("keys.theRecoveryKey")} />
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}
