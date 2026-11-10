"use client";

/**
 * The variants of one task, side by side: what each agent changed, and the
 * button that keeps one. Keeping one stops the others; their branches stay, so
 * nothing anybody made is thrown away by choosing.
 */

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import { runAction } from "@/lib/run-action";
import type { SessionView } from "@/lib/agents/session-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { agentText } from "@/lib/agents/words";
import { SessionChanges } from "@/components/agents/sessions/session-changes";
import { chooseVariantAction } from "../../actions";

interface Variant {
    id: string;
    runId: string;
    title: string;
    cli: string | null;
    status: string;
    chosen: boolean;
    result: string | null;
    session: SessionView | null;
}

export function CompareView({ variants }: { variants: Variant[] }) {
    const t = useTranslations("agents");
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();
    const kept = variants.some((variant) => variant.chosen);

    const keep = (variant: Variant) =>
        startTransition(() => {
            void runAction(
                () => chooseVariantAction({ runId: variant.runId, taskId: variant.id }),
                setError
            ).then((result) => {
                if (result?.error) setError(result.error);
                else router.refresh();
            });
        });

    return (
        <div className="space-y-3">
            <Link href="/apps/agents/orchestration" className="text-sm text-muted-foreground underline">
                {t("orchestration.back")}
            </Link>
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                {variants.map((variant) => (
                    <Card key={variant.id} className={variant.chosen ? "ring-1 ring-success" : ""}>
                        <CardBody className="min-w-0 space-y-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <p className="min-w-0 flex-1 truncate text-sm font-medium" title={variant.title}>
                                    {variant.title}
                                </p>
                                {variant.chosen ? <Badge>{t("orchestration.kept")}</Badge> : null}
                                {!kept && variant.status === "completed" ? (
                                    <Button size="sm" disabled={busy} onClick={() => keep(variant)}>
                                        {busy ? (
                                            <Loader2 className="size-4 shrink-0 animate-spin" />
                                        ) : (
                                            <Check className="size-4 shrink-0" />
                                        )}
                                        {t("orchestration.keep")}
                                    </Button>
                                ) : null}
                            </div>
                            {variant.result ? (
                                <p className="line-clamp-3 text-xs text-muted-foreground">
                                    {agentText(t, variant.result)}
                                </p>
                            ) : null}
                            {variant.session ? (
                                <SessionChanges session={variant.session} />
                            ) : (
                                <p className="text-sm text-muted-foreground">{t("orchestration.noChanges")}</p>
                            )}
                        </CardBody>
                    </Card>
                ))}
            </div>
        </div>
    );
}
