"use client";

/**
 * This reader's live translation of one conversation: what the others write
 * shown in their language, what they write sent in another, or both.
 *
 * Theirs alone. Nobody else's screen changes, and the stored messages never
 * do - see `chat.setChannelTranslation`.
 */

import { useEffect, useState } from "react";
import type { ChatTranslationPrefs } from "@polaris/core";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Switch
} from "@polaris/ui";
import * as actions from "./actions";
import { runAction } from "@/lib/run-action";
import { sameLanguage } from "@/lib/text-translation/logic";
import { useTextTranslator } from "@/components/text-translation/provider";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { LanguageSelect, languageLabel } from "@/components/text-translation/language-select";

/** The language offered first for what goes out: English, unless that is the
 *  reader's own, where a translation would be no translation. */
function firstOutgoing(own: string): string {
    return sameLanguage(own, "en") ? "es" : "en";
}

export function TranslationDialog({
    open,
    onOpenChange,
    channelId,
    current,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    channelId: string;
    current: ChatTranslationPrefs;
    onSaved: () => void;
}) {
    const t = useTranslations("chat");
    const locale = useLocale();
    const translator = useTextTranslator();
    const own = translator?.target ?? "en";
    const [incoming, setIncoming] = useState(current.incoming);
    const [outgoing, setOutgoing] = useState(current.outgoing !== null);
    const [language, setLanguage] = useState(current.outgoing ?? firstOutgoing(own));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) return;
        setIncoming(current.incoming);
        setOutgoing(current.outgoing !== null);
        setLanguage(current.outgoing ?? firstOutgoing(own));
        setError("");
    }, [open, current.incoming, current.outgoing, own]);

    const next: ChatTranslationPrefs = { incoming, outgoing: outgoing ? language : null };
    const changed = next.incoming !== current.incoming || next.outgoing !== current.outgoing;

    const save = async () => {
        setBusy(true);
        const result = await runAction(
            () => actions.setChannelTranslationAction({ channelId, ...next }),
            setError
        );
        setBusy(false);
        // Left open on a refusal, with the reason under it.
        if (!result || result.error) return;
        onOpenChange(false);
        onSaved();
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("translation.settings")}</DialogTitle>
                </DialogHeader>
                <p className="text-xs text-muted-foreground">{t("translation.settingsIntro")}</p>
                {!translator && (
                    <p className="text-xs text-danger">{t("translation.unavailable")}</p>
                )}
                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{t("translation.incoming")}</p>
                        <p id="translate-incoming-hint" className="text-xs text-muted-foreground">
                            {t("translation.incomingHint", {
                                language: languageLabel(own, locale)
                            })}
                        </p>
                    </div>
                    <Switch
                        checked={incoming}
                        onChange={setIncoming}
                        disabled={!translator}
                        aria-label={t("translation.incoming")}
                        aria-describedby="translate-incoming-hint"
                    />
                </div>
                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{t("translation.outgoing")}</p>
                        <p id="translate-outgoing-hint" className="text-xs text-muted-foreground">
                            {t("translation.outgoingHint")}
                        </p>
                    </div>
                    <Switch
                        checked={outgoing}
                        onChange={setOutgoing}
                        disabled={!translator}
                        aria-label={t("translation.outgoing")}
                        aria-describedby="translate-outgoing-hint"
                    />
                </div>
                {outgoing && (
                    <label className="flex min-w-0 items-center gap-3 text-sm">
                        <span className="shrink-0">{t("translation.outgoingLanguage")}</span>
                        <LanguageSelect
                            value={language}
                            onChange={setLanguage}
                            label={t("translation.outgoingLanguage")}
                            className="min-w-0 flex-1"
                        />
                    </label>
                )}
                {error ? <p className="text-xs text-danger">{error}</p> : null}
                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        {t("translation.cancel")}
                    </Button>
                    <Button
                        size="sm"
                        disabled={!changed || busy || !translator}
                        onClick={() => void save()}
                    >
                        {busy ? t("translation.saving") : t("translation.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
