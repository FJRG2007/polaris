"use client";

/**
 * The LibreTranslate server on Translate's settings: its address and an
 * optional API key. Saved on its own, after the server answered with them, so
 * an address that does not reach LibreTranslate is never kept.
 */

import { useTranslateT } from "./i18n";
import { useEffect, useId, useState } from "react";
import { Button, Input, Skeleton, useToast } from "@polaris/ui";
import { libreTranslateAction, saveLibreTranslateAction } from "../actions/translate";

interface Server {
    readonly url: string | null;
    readonly hasKey: boolean;
}

/** What the address field holds, as it would be kept; null when it is not an address. */
export function serverUrlOf(text: string): string | null | undefined {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
        const url = new URL(trimmed.replace(/\/+$/, ""));
        if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
        if (url.username || url.password) return undefined;
        return url.toString().replace(/\/+$/, "");
    } catch {
        return undefined;
    }
}

export function LibreTranslateServer() {
    const t = useTranslateT();
    const toast = useToast();
    const ids = useId();
    const [loaded, setLoaded] = useState<Server | null>(null);
    const [url, setUrl] = useState("");
    const [key, setKey] = useState("");
    const [dropKey, setDropKey] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        void libreTranslateAction().then((answer) => {
            if (!answer.ok) return;
            setLoaded(answer.server);
            setUrl(answer.server.url ?? "");
        });
    }, []);

    if (!loaded) return <Skeleton className="h-28 w-full max-w-sm" />;

    const wanted = serverUrlOf(url);
    const valid = wanted !== undefined;
    const changed = wanted !== loaded.url || key.trim() !== "" || dropKey;

    const save = async () => {
        setSaving(true);
        const answer = await saveLibreTranslateAction({
            url,
            ...(key.trim() ? { key } : dropKey ? { key: null } : {})
        });
        setSaving(false);
        if (!answer.ok) {
            toast.error(answer.error);
            return;
        }
        setLoaded(answer.server);
        setUrl(answer.server.url ?? "");
        setKey("");
        setDropKey(false);
        toast.success(t(answer.server.url ? "libretranslate.saved" : "libretranslate.off"));
    };

    return (
        <div className="max-w-sm space-y-2">
            <div className="min-w-0">
                <p className="text-sm font-medium">{t("libretranslate.title")}</p>
                <p className="text-xs text-muted-foreground">{t("libretranslate.description")}</p>
            </div>
            <label className="block space-y-1" htmlFor={`${ids}-url`}>
                <span className="text-xs font-medium">{t("libretranslate.url")}</span>
                <Input
                    id={`${ids}-url`}
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t("libretranslate.urlPlaceholder")}
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    aria-invalid={!valid}
                />
            </label>
            {!valid ? (
                <p className="text-xs text-destructive">{t("libretranslate.invalidUrl")}</p>
            ) : null}
            {wanted ? (
                <label className="block space-y-1" htmlFor={`${ids}-key`}>
                    <span className="text-xs font-medium">{t("libretranslate.key")}</span>
                    <Input
                        id={`${ids}-key`}
                        type="password"
                        autoComplete="off"
                        placeholder={t("libretranslate.keyNone")}
                        value={key}
                        onChange={(event) => setKey(event.target.value)}
                    />
                    {loaded.hasKey && !dropKey ? (
                        <span className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
                            <span className="min-w-0">{t("libretranslate.keyKept")}</span>
                            <Button variant="ghost" size="sm" onClick={() => setDropKey(true)}>
                                {t("libretranslate.removeKey")}
                            </Button>
                        </span>
                    ) : null}
                </label>
            ) : null}
            <div className="flex justify-end">
                <Button
                    variant="outline"
                    onClick={() => void save()}
                    disabled={!changed || !valid || saving}
                >
                    {t("libretranslate.save")}
                </Button>
            </div>
        </div>
    );
}
