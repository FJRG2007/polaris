"use client";

/** Where an account may sign in from, set by an administrator on top of the
 *  rules the account sets for itself. Saving signs them out everywhere. */

import { useState } from "react";
import { setUserLimitsAction } from "../actions";
import { Button, Card, CardBody } from "@polaris/ui";
import { useAccountAction } from "./use-account-action";
import type { DirectoryUser } from "@/lib/user-admin-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    AccessRulesEditor,
    accessRulesAreEmpty,
    accessRulesEqual,
    type AccessGroupOption,
    type AccessRulesValue
} from "@/components/access-rules-editor";

export function LimitsSection({
    user,
    groups
}: {
    user: DirectoryUser;
    groups: AccessGroupOption[];
}) {
    const t = useTranslations("admin");
    const { busy, error, run } = useAccountAction();
    const [limits, setLimits] = useState<AccessRulesValue>(user.enforced);

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">{t("usersDetail.account.limits.title")}</h2>
                    <p className="text-xs text-muted-foreground">
                        {t("usersDetail.account.limits.hint")}
                    </p>
                </div>
                <AccessRulesEditor value={limits} groups={groups} onChange={setLimits} />
                <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                        {accessRulesAreEmpty(limits)
                            ? t("usersDetail.account.limits.none")
                            : t("usersDetail.account.limits.some")}
                    </p>
                    <Button
                        size="sm"
                        disabled={busy || accessRulesEqual(limits, user.enforced)}
                        onClick={() => void run(() => setUserLimitsAction(user.id, limits))}
                    >
                        {t("usersDetail.account.limits.save")}
                    </Button>
                </div>
                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
