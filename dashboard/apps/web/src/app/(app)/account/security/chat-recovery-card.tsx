"use client";

/**
 * The Security page's line on quorum recovery of encrypted chats: who can
 * recover this account, the single administrator's warning, a request this
 * browser raised (its code and progress), and the requests waiting on this
 * account as a custodian. See lib/chat/e2ee/recovery-client.ts.
 */

import { SettingCard, Feedback } from "./setting-card";
import { useCallback, useEffect, useState } from "react";
import * as recovery from "@/lib/chat/e2ee/recovery-client";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { adoptRecoveredKey, deviceAccountHpke, keyState } from "@/lib/chat/e2ee/account-key-client";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@polaris/ui";

const POLL_MS = 15_000;

interface Loaded {
    userId: string;
    state: recovery.RecoveryState;
    own: recovery.OwnRequest | null;
    heldRequest: string | null;
    inbox: recovery.InboxItem[];
}

export function ChatRecoveryCard() {
    const t = useTranslations("accountSecurity");
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [code, setCode] = useState<string | null>(null);
    const [approving, setApproving] = useState<{ item: recovery.InboxItem; code: string } | null>(null);
    const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        const [keys, state, own, inbox] = await Promise.all([
            keyState(),
            recovery.recoveryState(),
            recovery.ownRequest(),
            recovery.custodianInbox()
        ]);
        if (!keys || !state) return;
        const heldRequest = await recovery.heldRequest(keys.userId);
        setLoaded({ userId: keys.userId, state, own, heldRequest, inbox });
        if (own?.request && heldRequest === own.request.id) {
            setCode(await recovery.codeOf(own.request.id, own.request.requesterKey));
            if (own.request.status === "released") {
                const done = await recovery.finishRequest(keys.userId, own, (key, version) =>
                    adoptRecoveredKey(keys.userId, key, version)
                );
                setMessage(done ? { tone: "ok", text: t("chatRecovery.recovered") } : { tone: "error", text: t("chatRecovery.failed") });
            }
        }
    }, [t]);

    useEffect(() => {
        void load();
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void load();
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [load]);

    const start = async () => {
        if (!loaded) return;
        setBusy(true);
        const started = await recovery.startRequest(loaded.userId).catch(() => null);
        setBusy(false);
        if (!started) return setMessage({ tone: "error", text: t("chatRecovery.refused") });
        setCode(started.code);
        await load();
    };

    const openApproval = async (item: recovery.InboxItem) =>
        setApproving({ item, code: await recovery.codeOf(item.id, item.requesterKey) });

    const confirmApproval = async () => {
        if (!loaded || !approving) return;
        setBusy(true);
        const ok = await recovery.approve(loaded.userId, approving.item, deviceAccountHpke).catch(() => false);
        setBusy(false);
        setApproving(null);
        setMessage(ok ? { tone: "ok", text: t("chatRecovery.approved") } : { tone: "error", text: t("chatRecovery.approveFailed") });
        await load();
    };

    // Nothing while the keys route is off (sealed chat not served) or not read yet.
    if (!loaded) return null;
    const state = loaded?.state;
    const holders = state?.shares.length ?? 0;
    const threshold = state?.shares[0]?.threshold ?? state?.threshold ?? 0;
    const description = !state
        ? t("chatRecovery.loading")
        : holders > 0
          ? state.orgName
              ? t("chatRecovery.org", { threshold, count: holders, org: state.orgName })
              : t("chatRecovery.instance", { threshold, count: holders })
          : state.custodians.length > 0
            ? t("chatRecovery.pending")
            : t("chatRecovery.nobody");
    const request = loaded?.own?.request;
    const mine = request && loaded?.heldRequest === request.id;

    return (
        <>
            <SettingCard
                title={t("chatRecovery.title")}
                description={description}
                status={holders > 0 ? t("chatRecovery.on") : undefined}
                statusTone="on"
            >
                {loaded?.own?.eligible && !mine ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void start()}>
                        {t("chatRecovery.start")}
                    </Button>
                ) : null}
            </SettingCard>
            {state && state.soleCustodianOf > 0 ? (
                <Feedback error={t("chatRecovery.soleCustodian", { count: state.soleCustodianOf })} />
            ) : null}
            {mine && code ? (
                <Feedback ok={t("chatRecovery.waiting", { code, approvals: request.approvals, threshold: request.threshold })} />
            ) : null}
            {loaded?.inbox.map((item) => (
                <SettingCard
                    key={item.id}
                    title={t("chatRecovery.inboxTitle", { name: item.ownerName ?? item.ownerEmail ?? "" })}
                    description={t("chatRecovery.inboxBody", { email: item.ownerEmail ?? "", threshold: item.threshold })}
                >
                    <Button size="sm" onClick={() => void openApproval(item)}>
                        {t("chatRecovery.review")}
                    </Button>
                </SettingCard>
            ))}
            {message ? <Feedback error={message.tone === "error" ? message.text : null} ok={message.tone === "ok" ? message.text : null} /> : null}
            <Dialog open={approving !== null} onOpenChange={(open) => !open && setApproving(null)}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>{t("chatRecovery.confirmTitle")}</DialogTitle>
                        <DialogDescription>
                            {t("chatRecovery.confirmBody", { name: approving?.item.ownerName ?? approving?.item.ownerEmail ?? "" })}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-4">
                        <p className="text-center font-mono text-lg tracking-widest">{approving?.code}</p>
                        <div className="flex justify-end gap-2">
                            <Button variant="outline" onClick={() => setApproving(null)}>
                                {t("chatRecovery.cancel")}
                            </Button>
                            <Button disabled={busy} onClick={() => void confirmApproval()}>
                                {t("chatRecovery.confirm")}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}
