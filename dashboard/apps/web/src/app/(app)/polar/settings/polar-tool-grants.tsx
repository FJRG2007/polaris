"use client";

/**
 * The list on Polar permissions: one row per "Always allow", with Revoke. A
 * revoke drops the row at once and puts it back if the server says no.
 */

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button, Card, CardBody } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useDisplayFormat } from "@/components/display-format";

export interface PolarToolGrantView {
    id: string;
    tool: string;
    /** The tool's title, or null when the catalog no longer has it. */
    title: string | null;
    /** The one thing it is allowed for, or null for the whole tool. */
    targetName: string | null;
    createdAt: string;
}

export function PolarToolGrants({ grants }: { grants: PolarToolGrantView[] }) {
    const t = useTranslations("account");
    const format = useDisplayFormat();
    const [rows, setRows] = useState(grants);
    const [failed, setFailed] = useState(false);

    async function revoke(grant: PolarToolGrantView) {
        setFailed(false);
        setRows((current) => current.filter((row) => row.id !== grant.id));
        const response = await fetch(`/api/polar/tool-grants/${grant.id}`, {
            method: "DELETE"
        }).catch(() => null);
        // Gone already counts as revoked; anything else puts the row back.
        if (response && (response.ok || response.status === 404)) return;
        setFailed(true);
        setRows((current) =>
            [...current, grant].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        );
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                {failed ? (
                    <p role="alert" className="text-sm text-danger">
                        {t("polarTools.revokeFailed")}
                    </p>
                ) : null}
                {rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("polarTools.empty")}</p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border">
                        {rows.map((grant) => {
                            const name = grant.title ?? grant.tool;
                            return (
                                <li key={grant.id} className="flex items-center gap-3 py-2">
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium" title={name}>
                                            {name}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {grant.title === null
                                                ? `${t("polarTools.unknownTool")} - `
                                                : ""}
                                            {grant.targetName
                                                ? t("polarTools.onlyTarget", {
                                                      target: grant.targetName
                                                  })
                                                : t("polarTools.anyTarget")}
                                            {" - "}
                                            {t("polarTools.allowedOn", {
                                                date: format.date(grant.createdAt)
                                            })}
                                        </p>
                                    </div>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        aria-label={t("polarTools.revokeLabel", { tool: name })}
                                        onClick={() => void revoke(grant)}
                                    >
                                        <Trash2 className="h-3.5 w-3.5 shrink-0" />
                                        {t("polarTools.revoke")}
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </CardBody>
        </Card>
    );
}
