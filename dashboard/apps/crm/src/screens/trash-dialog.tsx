"use client";

/**
 * A list's trash: the records moved there, newest change first, each one put
 * back or deleted for good. A record leaves the dialog the moment it is
 * pressed and comes back if the server does not agree.
 */

import { useCrmT } from "./i18n";
import { messageOf, unwrap } from "./call";
import * as actions from "../actions/records";
import { RotateCcw, Trash2 } from "lucide-react";
import { hostUi } from "@polaris/app-host/client";
import { useCallback, useEffect, useState } from "react";
import { recordName, type CrmObject, type CrmRecord } from "../model/objects";
import {
    Button,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    EmptyState,
    useToast
} from "@polaris/ui";

export interface TrashDialogProps {
    readonly object: CrmObject;
    readonly open: boolean;
    readonly canDelete: boolean;
    readonly onClose: () => void;
    /** Records went back to the list. */
    readonly onRestored: () => void;
    readonly confirm: (options: {
        title: string;
        description: string;
        confirmLabel: string;
        danger: boolean;
    }) => Promise<boolean>;
}

export function TrashDialog(props: TrashDialogProps) {
    const { object, open } = props;
    const t = useCrmT();
    const toast = useToast();
    const format = hostUi.displayFormat.useDisplayFormat();
    const [rows, setRows] = useState<readonly CrmRecord[] | null>(null);
    const [total, setTotal] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(
        (offset: number) => {
            setLoading(true);
            setError(null);
            unwrap(
                () => actions.listRecordsAction({ object, deleted: true, offset }),
                t("errors.loadFailed")
            )
                .then((page) => {
                    setRows((before) => [...(offset > 0 ? (before ?? []) : []), ...page.records]);
                    if (page.total !== null) setTotal(page.total);
                })
                .catch((caught) => setError(messageOf(caught)))
                .finally(() => setLoading(false));
        },
        [object, t]
    );

    useEffect(() => {
        if (open) load(0);
        else setRows(null);
    }, [open, load]);

    const take = async (record: CrmRecord, forever: boolean) => {
        if (forever) {
            const ok = await props.confirm({
                title: t("trashView.destroyTitle", { name: recordName(object, record) }),
                description: t("trashView.destroyBody"),
                confirmLabel: t("trashView.destroy"),
                danger: true
            });
            if (!ok) return;
        }
        const at = (rows ?? []).findIndex((one) => one.id === record.id);
        setRows((before) => (before ?? []).filter((one) => one.id !== record.id));
        setTotal((count) => count - 1);
        const call = forever ? actions.destroyRecordsAction : actions.restoreRecordsAction;
        unwrap(() => call({ object, ids: [record.id] }), t("errors.generic"))
            .then(() => {
                if (!forever) props.onRestored();
                toast.show({
                    title: forever ? t("trashView.destroyed") : t("trashView.restored")
                });
            })
            .catch((caught) => {
                setRows((before) => {
                    const list = (before ?? []).filter((one) => one.id !== record.id);
                    list.splice(at < 0 ? 0 : Math.min(at, list.length), 0, record);
                    return list;
                });
                setTotal((count) => count + 1);
                toast.show({ title: t("errors.notSaved"), body: messageOf(caught) });
            });
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !next && props.onClose()}>
            <DialogContent
                aria-describedby={undefined}
                className="flex max-h-[85dvh] flex-col sm:max-w-lg"
            >
                <DialogHeader>
                    <DialogTitle>{t("trashView.title")}</DialogTitle>
                </DialogHeader>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {rows === null && !error ? (
                        <div className="flex flex-col gap-2 py-2" aria-hidden>
                            {[0, 1, 2].map((at) => (
                                <span
                                    key={at}
                                    className="block h-8 animate-pulse rounded bg-muted"
                                />
                            ))}
                        </div>
                    ) : rows && rows.length === 0 ? (
                        <EmptyState icon={<Trash2 />} title={t("trashView.empty")} />
                    ) : (
                        <ul className="flex flex-col divide-y divide-border">
                            {(rows ?? []).map((record) => {
                                const name = recordName(object, record) || t("record.untitled");
                                return (
                                    <li
                                        key={record.id}
                                        className="flex min-w-0 items-center gap-2 py-2"
                                    >
                                        <div className="flex min-w-0 flex-1 flex-col">
                                            <span
                                                className="truncate text-[0.8125rem] font-medium"
                                                title={name}
                                            >
                                                {name}
                                            </span>
                                            {record.deletedAt ? (
                                                <span className="truncate text-[0.75rem] text-muted-foreground">
                                                    {t("trashView.deletedAt", {
                                                        when: format.dateTime(record.deletedAt)
                                                    })}
                                                </span>
                                            ) : null}
                                        </div>
                                        {props.canDelete ? (
                                            <>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() => void take(record, false)}
                                                    aria-label={t("trashView.restore")}
                                                    title={t("trashView.restore")}
                                                >
                                                    <RotateCcw className="size-4" />
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="text-danger"
                                                    onClick={() => void take(record, true)}
                                                    aria-label={t("trashView.destroy")}
                                                    title={t("trashView.destroy")}
                                                >
                                                    <Trash2 className="size-4" />
                                                </Button>
                                            </>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    {error ? (
                        <p role="alert" className="py-2 text-[0.8125rem] text-destructive">
                            {error}
                        </p>
                    ) : null}
                </div>
                {rows && rows.length < total ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={loading}
                        onClick={() => load(rows.length)}
                    >
                        {t("trashView.more")}
                    </Button>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}
