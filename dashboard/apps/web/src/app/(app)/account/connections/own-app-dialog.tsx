"use client";

/**
 * A Spotify app of one's own, added from the Spotify card.
 *
 * The deployment's app serves five people at most, so anybody past them makes
 * their own in Spotify's dashboard: the values it asks for are shown here ready
 * to copy, then its client id and secret are pasted back. The pair is checked
 * with Spotify before it is kept, and the secret is never shown again.
 */

import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ownOAuthAppSchema } from "@/lib/connections/own-oauth-app-schema";
import { removeOwnSpotifyAppAction, saveOwnSpotifyAppAction } from "./actions";
import {
    Button,
    CopyButton,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

/** The values Spotify's create-app form asks for, as this deployment answers. */
export type OwnAppValueKey = "appName" | "appDescription" | "homeUrl" | "redirectUri";

export interface OwnAppCard {
    /** The client id of the app in use, or null when there is none. */
    clientId: string | null;
    values: { key: OwnAppValueKey; value: string }[];
}

const CREATE_URL = "https://developer.spotify.com/dashboard/create";

export function OwnAppDialog({ ownApp, onClose }: { ownApp: OwnAppCard; onClose: () => void }) {
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const router = useRouter();
    const [clientId, setClientId] = useState("");
    const [clientSecret, setClientSecret] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const checked = ownOAuthAppSchema.safeParse({ clientId, clientSecret });
    // Only a field somebody has typed in is judged: an empty one is unfinished.
    const problem = (field: "clientId" | "clientSecret", value: string): string | null => {
        if (!value.trim() || checked.success) return null;
        const issue = checked.error.issues.find((one) => one.path[0] === field);
        return issue ? t(issue.message as Parameters<typeof t>[0]) : null;
    };
    const idProblem = problem("clientId", clientId);
    const secretProblem = problem("clientSecret", clientSecret);

    function run(action: () => Promise<{ error?: string }>) {
        setError(null);
        startTransition(async () => {
            const result = await runAction(action, (message) => setError(message));
            if (!result) return;
            if (result.error) {
                setError(result.error);
                return;
            }
            onClose();
            router.refresh();
        });
    }

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("connections.ownApp.title")}</DialogTitle>
                    <DialogDescription>{t("connections.ownApp.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
                        <li>
                            <a
                                href={CREATE_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
                            >
                                {t("connections.ownApp.create")}
                                <ExternalLink className="size-3.5" aria-hidden />
                            </a>
                            <span className="block text-xs text-muted-foreground">{t("connections.ownApp.createHelp")}</span>
                        </li>
                        <li>{t("connections.ownApp.paste")}</li>
                    </ol>
                    <dl className="flex flex-col gap-2">
                        {ownApp.values.map((entry) => (
                            <div key={entry.key} className="flex min-w-0 items-center gap-2">
                                <div className="min-w-0 flex-1">
                                    <dt className="text-xs text-muted-foreground">
                                        {t(`connections.ownApp.values.${entry.key}`)}
                                    </dt>
                                    <dd className="truncate font-mono text-xs" title={entry.value}>
                                        {entry.value}
                                    </dd>
                                </div>
                                <CopyButton value={entry.value} />
                            </div>
                        ))}
                    </dl>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("connections.ownApp.clientId")} *</span>
                        <Input
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={128}
                            value={clientId}
                            placeholder={ownApp.clientId ?? undefined}
                            aria-invalid={idProblem ? true : undefined}
                            onChange={(event) => setClientId(event.target.value)}
                        />
                        {idProblem ? <span className="text-xs text-danger">{idProblem}</span> : null}
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("connections.ownApp.clientSecret")} *</span>
                        <Input
                            type="password"
                            autoComplete="off"
                            maxLength={128}
                            value={clientSecret}
                            aria-invalid={secretProblem ? true : undefined}
                            onChange={(event) => setClientSecret(event.target.value)}
                        />
                        {secretProblem ? <span className="text-xs text-danger">{secretProblem}</span> : null}
                    </label>
                    <p className="text-xs text-muted-foreground">{t("connections.ownApp.premium")}</p>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>
                <DialogFooter>
                    {ownApp.clientId ? (
                        <Button
                            variant="ghost"
                            className="mr-auto"
                            disabled={pending}
                            onClick={() => run(() => removeOwnSpotifyAppAction())}
                        >
                            {t("connections.ownApp.remove")}
                        </Button>
                    ) : null}
                    <Button variant="ghost" onClick={onClose} disabled={pending}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button
                        onClick={() => checked.success && run(() => saveOwnSpotifyAppAction(checked.data))}
                        disabled={pending || !checked.success}
                    >
                        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                        {tc("actions.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
