"use client";

/**
 * Whether what this account sends to be seen once carries the reader's name and
 * the time. Turning it on saves at once; turning it off is asked first, since a
 * photo of the screen from another device is then a copy with nobody's name on
 * it. Put back if the save is refused.
 */

import { useState } from "react";
import { Stamp } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { saveViewOnceWatermarkAction } from "@/app/(app)/account/privacy/actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Switch
} from "@polaris/ui";

export function ViewOnceWatermarkCard({ on }: { on: boolean }) {
    const t = useTranslations("accountPrivacy");
    const [value, setValue] = useState(on);
    const [saving, setSaving] = useState(false);
    const [asking, setAsking] = useState(false);
    const [error, setError] = useState("");

    const save = async (next: boolean) => {
        if (next === value) return;
        const before = value;
        setValue(next);
        setError("");
        setSaving(true);
        const result = await runAction(() => saveViewOnceWatermarkAction(next), setError);
        setSaving(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            setValue(before);
        }
    };

    return (
        <Card>
            <CardBody className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                <Stamp className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-[14rem] flex-1">
                    <span className="block text-[0.8125rem]">{t("viewOnceWatermark.label")}</span>
                    <span className="block text-[0.6875rem] leading-snug text-foreground-subtle">
                        {t("viewOnceWatermark.hint")}
                    </span>
                    {error && (
                        <span role="alert" className="block text-xs text-danger">
                            {error}
                        </span>
                    )}
                </span>
                <Switch
                    checked={value}
                    disabled={saving}
                    aria-label={t("viewOnceWatermark.label")}
                    onChange={(next) => (next ? void save(true) : setAsking(true))}
                />
            </CardBody>
            <Dialog open={asking} onOpenChange={setAsking}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("viewOnceWatermark.confirmTitle")}</DialogTitle>
                        <DialogDescription>{t("viewOnceWatermark.confirmBody")}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setAsking(false)}>
                            {t("viewOnceWatermark.keep")}
                        </Button>
                        <Button
                            variant="danger"
                            onClick={() => {
                                setAsking(false);
                                void save(false);
                            }}
                        >
                            {t("viewOnceWatermark.turnOff")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Card>
    );
}
