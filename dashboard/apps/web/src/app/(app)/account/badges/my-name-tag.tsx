"use client";

/**
 * Which one tag this person wears after their name, or none. The list loads
 * after the first paint; the card's heading does not wait for it.
 */

import { useCallback, useEffect, useState } from "react";
import * as core from "@polaris/core";
import { Button, Card, CardBody, CardHeader, CardTitle, Select, Skeleton } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { NameTagLabel } from "@/components/name-tags/name-tag-chip";
import { nameTagErrorKey } from "@/components/name-tags/name-tag-editor";
import { forgetNameTags } from "@/components/name-tags/name-tag-store";
import { chooseNameTagAction, loadMyNameTagsAction } from "@/app/(app)/name-tag-actions";
import type { MyNameTags } from "@/lib/name-tags/name-tag-service";

function keyOf(choice: core.NameTagChoice): string {
    return choice.source === "org" ? choice.orgId : choice.source;
}

export function MyNameTag() {
    const t = useTranslations("badges");
    const [data, setData] = useState<MyNameTags | null | "failed">(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
        setData(null);
        loadMyNameTagsAction().then(setData, () => setData("failed"));
    }, []);
    useEffect(load, [load]);

    const choose = async (choice: core.NameTagChoice) => {
        if (data === null || data === "failed" || keyOf(choice) === keyOf(data.chosen)) return;
        const before = data;
        setError(null);
        // Moved first, put back if the server refuses.
        setData({ ...data, chosen: choice });
        const result = await chooseNameTagAction(choice).catch(() => ({ error: "invalid" }));
        if (result.error) {
            setData(before);
            setError(nameTagErrorKey(result.error));
            return;
        }
        forgetNameTags();
    };

    const rows: { choice: core.NameTagChoice; name: string; tag: core.NameTagView | null }[] =
        data && data !== "failed"
            ? [
                  { choice: { source: "none" }, name: t("nameTags.mine.none"), tag: null },
                  ...data.options.map((option) => ({
                      choice:
                          option.orgId === null
                              ? ({ source: "instance" } as const)
                              : ({ source: "org", orgId: option.orgId } as const),
                      name: option.name,
                      tag: option.tag
                  }))
              ]
            : [];

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("nameTags.mine.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-muted-foreground text-xs">{t("nameTags.mine.intro")}</p>
                {data === null && <Skeleton className="h-16 w-full" />}
                {data === "failed" && (
                    <div className="flex items-center justify-between gap-2 text-sm">
                        <span>{t("nameTags.mine.loadFailed")}</span>
                        <Button size="sm" variant="ghost" onClick={load}>
                            {t("nameTags.mine.retry")}
                        </Button>
                    </div>
                )}
                {data && data !== "failed" && (
                    <div className="flex flex-col gap-1">
                        <Select
                            aria-label={t("nameTags.mine.title")}
                            value={keyOf(data.chosen)}
                            onValueChange={(value) => {
                                const row = rows.find(
                                    (candidate) => keyOf(candidate.choice) === value
                                );
                                if (row) void choose(row.choice);
                            }}
                            options={rows.map((row) => ({
                                value: keyOf(row.choice),
                                label: row.name,
                                icon: row.tag ? <NameTagLabel tag={row.tag} /> : undefined
                            }))}
                            className="w-full sm:max-w-sm"
                        />
                        {data.options.length === 0 && (
                            <p className="text-muted-foreground text-xs">
                                {t("nameTags.mine.empty")}
                            </p>
                        )}
                    </div>
                )}
                {error && (
                    <p
                        role="alert"
                        className="bg-danger-soft text-danger-ink rounded-md px-3 py-2 text-sm"
                    >
                        {t(`nameTags.errors.${error as "invalid"}`)}
                    </p>
                )}
            </CardBody>
        </Card>
    );
}
