"use client";

/**
 * How many accounts with a password already sign in without sending it. Read
 * only: an account moves by itself at its next sign-in.
 */

import { Card, CardBody, settingType } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function PasswordMigrationCard({ moved, total }: { moved: number; total: number }) {
    const t = useTranslations("admin");
    return (
        <Card>
            <CardBody className="flex flex-col gap-1">
                <h2 className="text-sm font-medium">{t("security.passwordMigration.title")}</h2>
                <p className={settingType.hint}>
                    {t("security.passwordMigration.summary", {
                        total,
                        moved: moved.toLocaleString(),
                        shown: total.toLocaleString()
                    })}
                </p>
            </CardBody>
        </Card>
    );
}
