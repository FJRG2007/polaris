"use client";

/**
 * Polar in an editor: the block Zed, a JetBrains IDE or any other Agent
 * Client Protocol client takes, generated for this instance's address
 * (`lib/polar/acp-setup.ts`), with a key made here and written into it.
 */

import Link from "next/link";
import { useState } from "react";
import { useAppUrl } from "@/components/app-url";
import { JsonView } from "@/components/json-view";
import { Button, SegmentedControl, useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { createApiKeyAction } from "@/app/(app)/account/api-keys/actions";
import { ACP_EDITORS, acpSnippet, type AcpEditor } from "@/lib/polar/acp-setup";

export function EditorsCard() {
    const t = useTranslations("polar");
    const toast = useToast();
    const base = useAppUrl().replace(/\/+$/, "");
    const [editor, setEditor] = useState<AcpEditor>("zed");
    const [secret, setSecret] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);

    const createKey = async () => {
        setCreating(true);
        try {
            const created = await createApiKeyAction({ name: t("routing.editors.keyName"), scopes: ["polar.use"] });
            if (created.secret) setSecret(created.secret);
            else toast.show({ title: created.error ?? t("routing.editors.keyFailed") });
        } catch {
            toast.show({ title: t("routing.editors.keyFailed") });
        } finally {
            setCreating(false);
        }
    };

    return (
        <section className="flex min-w-0 flex-col gap-2">
            <div className="min-w-0">
                <h3 className="text-sm font-medium text-foreground">{t("routing.editors.title")}</h3>
                <p className="text-xs text-muted-foreground">{t("routing.editors.intro")}</p>
            </div>
            <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border px-3 py-2">
                <SegmentedControl
                    value={editor}
                    onValueChange={setEditor}
                    size="sm"
                    aria-label={t("routing.editors.pick")}
                    options={ACP_EDITORS.map((value) => ({ value, label: t(`routing.editors.${value}.name`) }))}
                />
                <p className="text-xs text-muted-foreground">{t(`routing.editors.${editor}.where`)}</p>
                <JsonView value={acpSnippet(editor, base, secret ?? undefined)} label={t(`routing.editors.${editor}.name`)} />
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {secret ? (
                        <p className="min-w-0 text-xs text-muted-foreground">{t("routing.editors.keyMade")}</p>
                    ) : (
                        <>
                            <Button size="sm" variant="outline" onClick={createKey} disabled={creating}>
                                {t("routing.editors.createKey")}
                            </Button>
                            <p className="min-w-0 text-xs text-muted-foreground">
                                {t.rich("routing.editors.keyHint", {
                                    link: (chunks) => (
                                        <Link key="link" href="/account/api-keys" className="text-primary hover:underline">
                                            {chunks}
                                        </Link>
                                    )
                                })}
                            </p>
                        </>
                    )}
                </div>
                <p className="text-xs text-muted-foreground">{t("routing.editors.node")}</p>
            </div>
        </section>
    );
}
