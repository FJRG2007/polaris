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
    SettingRow,
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
            <CardBody className="p-3">
                <SettingRow
                    id="chat-view-once-watermark"
                    icon={<Stamp />}
                    label={t("viewOnceWatermark.label")}
                    hint={t("viewOnceWatermark.hint")}
                    error={error}
                >
                    <Switch
                        checked={value}
                        disabled={saving}
                        aria-label={t("viewOnceWatermark.label")}
                        aria-describedby="chat-view-once-watermark-hint"
                        onChange={(next) => (next ? void save(true) : setAsking(true))}
                    />
                </SettingRow>
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
