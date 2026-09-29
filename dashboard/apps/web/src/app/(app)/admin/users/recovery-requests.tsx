"use client";

/**
 * People who cannot get into their own account.
 *
 * The card only appears while somebody is waiting, because there is nothing to
 * manage otherwise. What it has to make obvious is the difference between a
 * request that answered its security questions and one that could not: the first
 * is a person who forgot a password, the second is a claim with nothing behind
 * it, and the same button does very different things in the two cases.
 */

import { useState } from "react";
import { LifeBuoy } from "lucide-react";
import { useRouter } from "next/navigation";
import { decideRecoveryRequestAction } from "./actions";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { RecoveryRequestView } from "@/lib/account-recovery-service";

export function RecoveryRequests({ requests }: { requests: RecoveryRequestView[] }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const router = useRouter();
    const format = useDisplayFormat();
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Decided rows drop out of the list here rather than waiting for the page to
    // come back with them gone: a decision that stays on screen reads as one that
    // did not take, and the obvious thing to do about that is press it again.
    const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());

    const waiting = requests.filter((request) => !decided.has(request.id));
    if (waiting.length === 0) return null;

    async function decide(id: string, approve: boolean) {
        setBusyId(id);
        setError(null);
        setDecided((previous) => new Set(previous).add(id));
        const result = await decideRecoveryRequestAction(id, approve);
        setBusyId(null);
        if (result.error) {
            // It is back: whatever went wrong, the request has not been dealt with.
            setDecided((previous) => {
                const next = new Set(previous);
                next.delete(id);
                return next;
            });
            setError(result.error);
            return;
        }
        router.refresh();
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="flex items-center gap-1.5 text-sm font-medium">
                        <LifeBuoy className="size-4 text-warning" />
                        {t("users.recovery.title")}
                    </h2>
                    <p className="text-xs text-muted-foreground">{t("users.recovery.hint")}</p>
                </div>
                {waiting.map((request) => (
                    <div
                        key={request.id}
                        className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0 sm:flex-row sm:items-center sm:justify-between"
                    >
                        <div className="min-w-0">
                            <p className="flex flex-wrap items-center gap-1.5 text-sm">
                                <span className="truncate font-medium">{request.userName}</span>
                                {request.verified ? (
                                    <Badge variant="success">{t("users.recovery.verified")}</Badge>
                                ) : (
                                    <Badge variant="warning">{t("users.recovery.unverified")}</Badge>
                                )}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">{request.userEmail}</p>
                            <p className="text-xs text-muted-foreground">
                                {request.requestIp
                                    ? t("users.recovery.askedFrom", {
                                          asked: format.dateTime(request.createdAt),
                                          ip: request.requestIp,
                                          expires: format.dateTime(request.expiresAt)
                                      })
                                    : t("users.recovery.asked", {
                                          asked: format.dateTime(request.createdAt),
                                          expires: format.dateTime(request.expiresAt)
                                      })}
                            </p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                            <Button
                                variant="ghost"
                                disabled={busyId === request.id}
                                onClick={() => void decide(request.id, false)}
                            >
                                {t("users.recovery.deny")}
                            </Button>
                            <Button
                                disabled={busyId === request.id}
                                onClick={() => void decide(request.id, true)}
                            >
                                {busyId === request.id ? tc("actions.saving") : t("users.recovery.approve")}
                            </Button>
                        </div>
                    </div>
                ))}
                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
