"use client";

/**
 * The save at the foot of every Network filter section that edits its settings.
 *
 * The form is one row shared by every section, so an edit made on Lists is
 * still waiting when Settings is opened, and Save here saves both. It is also
 * where a server running older settings says so and offers to apply them, since
 * any of these sections can be what made it older.
 */

import { Loader2 } from "lucide-react";
import { Button, Card, CardBody } from "@polaris/ui";
import { useDnsBlocker } from "./dns-blocker-context";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function DnsSaveBar() {
    const t = useTranslations("dnsBlocker");
    const { status, switching, switchTo, saving, save, dirty, valid, engineExists, notice } =
        useDnsBlocker();
    const off = !dirty || !valid || saving;
    const stale = status?.stale === true && status.state === "blocking";

    return (
        <Card className="sticky bottom-2 z-10 shadow-md">
            <CardBody className="flex flex-col gap-2">
                {stale ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft p-2">
                        <p className="min-w-0 flex-1 text-sm text-warning-ink">
                            {t("status.stale")}
                        </p>
                        <Button size="sm" onClick={() => switchTo(true)} disabled={switching}>
                            {switching ? <Loader2 className="animate-spin" /> : null}
                            {t("status.apply")}
                        </Button>
                    </div>
                ) : null}
                <div className="flex flex-wrap items-center justify-end gap-3">
                    {notice ? (
                        <p
                            role={notice.tone === "error" ? "alert" : "status"}
                            className={`min-w-0 flex-1 text-sm ${notice.tone === "error" ? "text-danger" : "text-success"}`}
                        >
                            {notice.text}
                        </p>
                    ) : dirty ? (
                        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                            {t("settings.unsaved")}
                        </p>
                    ) : null}
                    <Button onClick={save} disabled={off} aria-disabled={off}>
                        {saving ? <Loader2 className="animate-spin" /> : null}
                        {engineExists ? t("settings.saveApply") : t("settings.save")}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
