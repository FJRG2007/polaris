"use client";

/**
 * Merge the selected records into one: pick the record to keep, and the others
 * fill its empty fields and go to the trash.
 */

import { useCrmT } from "./i18n";
import { messageOf, unwrap } from "./call";
import * as actions from "../actions/records";
import { useState, type FormEvent } from "react";
import { recordName, type CrmObject, type CrmRecord } from "../model/objects";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    useToast
} from "@polaris/ui";

export interface MergeDialogProps {
    readonly object: CrmObject;
    readonly records: readonly CrmRecord[];
    readonly onMerged: (record: CrmRecord, trashed: string[]) => void;
    readonly onClose: () => void;
}

export function MergeDialog({ object, records, onMerged, onClose }: MergeDialogProps) {
    const t = useCrmT();
    const toast = useToast();
    const [keepId, setKeepId] = useState(records[0]?.id ?? "");
    const [busy, setBusy] = useState(false);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (busy || !keepId) return;
        const ids = records.map((record) => record.id).filter((id) => id !== keepId);
        setBusy(true);
        unwrap(() => actions.mergeRecordsAction({ object, keepId, ids }), t("errors.generic"))
            .then(({ record }) => {
                toast.show({ title: t("merge.done") });
                onMerged(record, ids);
            })
            .catch((caught) => {
                toast.show({ title: t("errors.generic"), body: messageOf(caught) });
                setBusy(false);
            });
    };

    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent className="max-w-md">
                <form onSubmit={submit} className="flex flex-col gap-4">
                    <DialogHeader>
                        <DialogTitle>{t("merge.title", { count: records.length })}</DialogTitle>
                        <DialogDescription>{t("merge.keep")}</DialogDescription>
                    </DialogHeader>
                    <fieldset className="flex max-h-64 min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain">
                        {records.map((record) => {
                            const name = recordName(object, record);
                            return (
                                <label
                                    key={record.id}
                                    className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-hover"
                                >
                                    <input
                                        type="radio"
                                        name="crm-merge-keep"
                                        value={record.id}
                                        checked={keepId === record.id}
                                        onChange={() => setKeepId(record.id)}
                                    />
                                    <span className="min-w-0 truncate" title={name}>
                                        {name}
                                    </span>
                                </label>
                            );
                        })}
                    </fieldset>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                            {t("actions.cancel")}
                        </Button>
                        <Button type="submit" disabled={busy || !keepId}>
                            {t("merge.confirm")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
