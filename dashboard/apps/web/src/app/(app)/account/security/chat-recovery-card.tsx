"use client";

/**
 * The Security page's line on quorum recovery of encrypted chats: who can
 * recover this account, the single administrator's warning, a request this
 * browser raised (its code, approvals and declines), the requests waiting on
 * this account as a custodian, and - for a custodian - each organisation
 * recovery key: opening it with the other administrators when members came
 * back for history only it holds or the administrators changed, and approving
 * another administrator's opening. See lib/chat/e2ee/recovery-client.ts.
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
    keys: recovery.RecoveryKeyScope[];
    /** Openings of this account that this browser raised (and so shows the code of). */
    heldOpenings: Record<string, string>;
}

type Approving =
    | { kind: "account"; item: recovery.InboxItem; code: string }
    | { kind: "key"; entry: recovery.RecoveryKeyScope; opening: recovery.KeyOpening; code: string };

export function ChatRecoveryCard() {
    const t = useTranslations("accountSecurity");
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [code, setCode] = useState<string | null>(null);
    const [approving, setApproving] = useState<Approving | null>(null);
    const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        const [keys, state, own, inbox, scopes] = await Promise.all([
            keyState(),
            recovery.recoveryState(),
            recovery.ownRequest(),
            recovery.custodianInbox(),
            recovery.recoveryKeyState()
        ]);
        if (!keys || !state) return;
        const heldRequest = await recovery.heldRequest(keys.userId);
        const heldOpenings: Record<string, string> = {};
        for (const entry of scopes ?? [])
            for (const opening of entry.openings) {
                if (!opening.mine || !(await recovery.holdsOpening(opening.id))) continue;
                if (opening.status === "released") {
                    const sealed = await recovery.finishOpening(keys.userId, entry, opening).catch(() => null);
                    if (sealed !== null) setMessage({ tone: "ok", text: t("chatRecovery.keyFinished", { count: sealed }) });
                } else heldOpenings[opening.id] = await recovery.codeOf(opening.id, opening.requesterKey);
            }
        setLoaded({ userId: keys.userId, state, own, heldRequest, inbox, keys: scopes ?? [], heldOpenings });
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
        setApproving({ kind: "account", item, code: await recovery.codeOf(item.id, item.requesterKey) });

    const openKeyApproval = async (entry: recovery.RecoveryKeyScope, opening: recovery.KeyOpening) =>
        setApproving({ kind: "key", entry, opening, code: await recovery.codeOf(opening.id, opening.requesterKey) });

    const startOpening = async (entry: recovery.RecoveryKeyScope) => {
        if (!loaded) return;
        setBusy(true);
        const started = await recovery.startOpening(loaded.userId, entry, deviceAccountHpke).catch(() => null);
        setBusy(false);
        if (!started) setMessage({ tone: "error", text: t("chatRecovery.keyOpenFailed") });
        await load();
    };

    const confirmApproval = async () => {
        if (!loaded || !approving) return;
        setBusy(true);
        const ok = await (approving.kind === "account"
            ? recovery.approve(loaded.userId, approving.item, deviceAccountHpke)
            : recovery.approveOpening(loaded.userId, approving.entry, approving.opening, deviceAccountHpke)
        ).catch(() => false);
        setBusy(false);
        setApproving(null);
        setMessage(ok ? { tone: "ok", text: t("chatRecovery.approved") } : { tone: "error", text: t("chatRecovery.approveFailed") });
        await load();
    };

    const declineApproval = async () => {
        if (!approving) return;
        setBusy(true);
        const ok = await (approving.kind === "account" ? recovery.decline(approving.item) : recovery.declineOpening(approving.opening)).catch(
            () => false
        );
        setBusy(false);
        setApproving(null);
        setMessage(ok ? { tone: "ok", text: t("chatRecovery.declined") } : { tone: "error", text: t("chatRecovery.declineFailed") });
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
    const orgOf = (entry: recovery.RecoveryKeyScope) => entry.orgName ?? t("chatRecovery.keyInstance");
    const approvingName =
        approving?.kind === "account"
            ? (approving.item.ownerName ?? approving.item.ownerEmail ?? "")
            : (approving?.opening.openerName ?? approving?.opening.openerEmail ?? "");

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
            {mine && request.declines > 0 ? (
                <Feedback error={t("chatRecovery.declines", { count: request.declines, threshold: request.threshold })} />
            ) : null}
            {loaded.keys.map((entry) => {
                const key = entry.key;
                if (!key?.share || !key.openable) return null;
                const own = entry.openings.find((opening) => opening.mine && loaded.heldOpenings[opening.id]);
                const others = entry.openings.filter((opening) => !opening.mine && opening.status === "pending" && !opening.ownReleased);
                const needed = entry.waiting > 0 || !key.current;
                return (
                    <div key={entry.scope} className="flex flex-col gap-3">
                        {needed && !own ? (
                            <SettingCard
                                title={t("chatRecovery.keyTitle", { org: orgOf(entry) })}
                                description={entry.waiting > 0 ? t("chatRecovery.keyWaiting", { count: entry.waiting }) : t("chatRecovery.keyResplit")}
                            >
                                <Button size="sm" variant="outline" disabled={busy} onClick={() => void startOpening(entry)}>
                                    {t("chatRecovery.keyOpen")}
                                </Button>
                            </SettingCard>
                        ) : null}
                        {own ? (
                            <Feedback
                                ok={t("chatRecovery.keyOpening", {
                                    code: loaded.heldOpenings[own.id] ?? "",
                                    released: own.released,
                                    threshold: own.threshold
                                })}
                            />
                        ) : null}
                        {own && own.declined > 0 ? (
                            <Feedback error={t("chatRecovery.declines", { count: own.declined, threshold: own.threshold })} />
                        ) : null}
                        {others.map((opening) => (
                            <SettingCard
                                key={opening.id}
                                title={t("chatRecovery.keyInboxTitle", { name: opening.openerName ?? opening.openerEmail ?? "", org: orgOf(entry) })}
                                description={t("chatRecovery.keyInboxBody", { threshold: opening.threshold })}
                            >
                                <Button size="sm" onClick={() => void openKeyApproval(entry, opening)}>
                                    {t("chatRecovery.review")}
                                </Button>
                            </SettingCard>
                        ))}
                    </div>
                );
            })}
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
                        <DialogTitle>{t(approving?.kind === "key" ? "chatRecovery.keyConfirmTitle" : "chatRecovery.confirmTitle")}</DialogTitle>
                        <DialogDescription>
                            {t(approving?.kind === "key" ? "chatRecovery.keyConfirmBody" : "chatRecovery.confirmBody", { name: approvingName })}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-4">
                        <p className="text-center font-mono text-lg tracking-widest">{approving?.code}</p>
                        <div className="flex justify-end gap-2">
                            <Button variant="outline" onClick={() => setApproving(null)}>
                                {t("chatRecovery.cancel")}
                            </Button>
                            <Button variant="outline" disabled={busy} onClick={() => void declineApproval()}>
                                {t("chatRecovery.decline")}
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
