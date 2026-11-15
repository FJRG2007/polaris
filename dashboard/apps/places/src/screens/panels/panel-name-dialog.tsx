"use client";

/** The name dialog of a wall panel, for a new one and a rename. */

import { useState } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";
import { usePlacesT } from "../use-places-t";
import { PANEL_NAME_MAX, normalizePanelName, panelNameSchema } from "../../lib/panel-layout";

/** The name dialog, for a new panel and a rename. Checked as it is typed. */
export function NameDialog({
    open,
    title,
    initial,
    confirm,
    onClose,
    onSubmit
}: {
    open: boolean;
    title: string;
    initial: string;
    confirm: string;
    onClose: () => void;
    onSubmit: (name: string) => Promise<string | null>;
}) {
    const t = usePlacesT();
    const [name, setName] = useState(initial);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const normalized = normalizePanelName(name);
    const check = panelNameSchema.safeParse(normalized);
    const issue = normalized.length > 0 && !check.success ? check.error.issues[0]?.message : "";
    const unchanged = normalized === normalizePanelName(initial);
    const submit = async () => {
        if (!check.success || unchanged) return;
        setBusy(true);
        const refused = await onSubmit(check.data);
        setBusy(false);
        if (refused) setError(refused);
        else onClose();
    };
    return (
        <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>
                <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <label className="flex flex-col gap-1 text-sm">
                        <span>
                            {t("panels.name")} <span aria-hidden>*</span>
                        </span>
                        <Input
                            autoFocus
                            value={name}
                            maxLength={PANEL_NAME_MAX + 20}
                            placeholder={t("panels.namePlaceholder")}
                            aria-invalid={Boolean(issue)}
                            onChange={(event) => {
                                setName(event.target.value);
                                setError("");
                            }}
                        />
                    </label>
                    {issue || error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error ||
                                (issue === "That name is too long"
                                    ? t("refusals.panelNameLong")
                                    : t("refusals.panelName"))}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>
                            {t("panels.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            aria-disabled={!check.success || unchanged || busy}
                            disabled={busy}
                        >
                            {confirm}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
