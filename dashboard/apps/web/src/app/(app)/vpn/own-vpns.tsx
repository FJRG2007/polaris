"use client";

/**
 * The VPNs a person already has elsewhere, next to the ones this Polaris offers.
 * Choosing one here selects it; the screen around it holds the Connect button.
 */

import { toast } from "sonner";
import * as ui from "@polaris/ui";
import * as actions from "./profile-actions";
import { Trash2, Upload } from "lucide-react";
import type { ConnectAnswer } from "./connect-actions";
import { MAX_PROFILES } from "@/lib/vpn/profile-limits";
import { useRef, useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";

type Profile = ConnectAnswer["profiles"][number];

interface OwnVpnsProps {
    readonly profiles: readonly Profile[];
    readonly selected: string | null;
    readonly active: string | null;
    readonly where: (profile: Profile) => string;
    readonly onSelect: (id: string) => void;
    readonly onChanged: () => void;
    readonly onError: (message: string | null) => void;
}

export function OwnVpns(props: OwnVpnsProps) {
    const { profiles, selected, active, where, onSelect, onChanged, onError } = props;
    const t = useTranslations("vpn");
    const input = useRef<HTMLInputElement>(null);
    const [removing, setRemoving] = useState<Profile | null>(null);
    const [pending, startTransition] = useTransition();

    function importFiles(list: FileList | null): void {
        const chosen = [...(list ?? [])].slice(0, MAX_PROFILES);
        if (chosen.length === 0) return;
        onError(null);
        startTransition(async () => {
            const files = await Promise.all(
                chosen.map(async (file) => ({ name: file.name, text: await file.text() }))
            );
            const result = await actions.importProfilesAction(files);
            if (input.current) input.current.value = "";
            if (result.error !== undefined) return onError(result.error);
            if (result.added > 0) toast.success(t("connect.own.added", { count: result.added }));
            if (result.rejected.length > 0) {
                onError(t("connect.own.rejected", { names: result.rejected.join(", ") }));
            }
            onChanged();
        });
    }

    function remove(profile: Profile): void {
        onError(null);
        startTransition(async () => {
            const result = await actions.removeProfileAction(profile.id);
            setRemoving(null);
            if (result.error !== undefined) onError(result.error);
            onChanged();
        });
    }

    return (
        <section className="mt-2 flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 items-center justify-between gap-2">
                <h2 className="min-w-0 truncate text-sm font-medium">{t("connect.own.title")}</h2>
                <ui.Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => input.current?.click()}
                >
                    <Upload />
                    {t("connect.own.import")}
                </ui.Button>
                <input
                    ref={input}
                    type="file"
                    multiple
                    accept=".conf"
                    hidden
                    aria-label={t("connect.own.import")}
                    onChange={(event) => importFiles(event.target.files)}
                />
            </div>
            {profiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("connect.own.hint")}</p>
            ) : (
                <div
                    role="radiogroup"
                    aria-label={t("connect.own.title")}
                    className="flex max-h-64 min-w-0 flex-col gap-1 overflow-y-auto"
                >
                    {profiles.map((profile) => (
                        <div
                            key={profile.id}
                            className={ui.cn(
                                "flex min-w-0 items-center rounded-md",
                                profile.id === selected ? "bg-muted" : "hover:bg-muted/60"
                            )}
                        >
                            <button
                                type="button"
                                role="radio"
                                aria-checked={profile.id === selected}
                                onClick={() => onSelect(profile.id)}
                                className="flex min-w-0 flex-1 flex-col px-3 py-2 text-left text-sm"
                            >
                                <span className="truncate font-medium" title={profile.name}>
                                    {profile.name}
                                </span>
                                {where(profile) ? (
                                    <span className="truncate text-xs text-muted-foreground">
                                        {where(profile)}
                                    </span>
                                ) : null}
                            </button>
                            {profile.id === active ? (
                                <ui.Badge variant="success">{t("connect.online")}</ui.Badge>
                            ) : null}
                            <ui.Button
                                size="icon"
                                variant="ghost"
                                disabled={pending || profile.id === active}
                                aria-label={t("connect.own.remove", { name: profile.name })}
                                title={
                                    profile.id === active
                                        ? t("connect.own.inUse")
                                        : t("connect.own.remove", { name: profile.name })
                                }
                                onClick={() => setRemoving(profile)}
                            >
                                <Trash2 />
                            </ui.Button>
                        </div>
                    ))}
                </div>
            )}
            <ui.Dialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
                <ui.DialogContent>
                    <ui.DialogHeader>
                        <ui.DialogTitle>
                            {t("connect.own.removeTitle", { name: removing?.name ?? "" })}
                        </ui.DialogTitle>
                        <ui.DialogDescription>{t("connect.own.removeBody")}</ui.DialogDescription>
                    </ui.DialogHeader>
                    <ui.DialogFooter>
                        <ui.Button variant="outline" onClick={() => setRemoving(null)}>
                            {t("connect.cancel")}
                        </ui.Button>
                        <ui.Button
                            variant="danger"
                            disabled={pending}
                            onClick={() => removing && remove(removing)}
                        >
                            {t("connect.own.removeConfirm")}
                        </ui.Button>
                    </ui.DialogFooter>
                </ui.DialogContent>
            </ui.Dialog>
        </section>
    );
}
