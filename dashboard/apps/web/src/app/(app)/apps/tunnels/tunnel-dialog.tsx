"use client";

/**
 * The form that opens a tunnel: which public server receives visitors, which
 * service they reach, and the hostname. A service already on the chosen server is
 * not offered - it needs no tunnel, and the server refuses it anyway.
 */

import { Plus } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createTunnelAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { DeployTargetPicker, ServicePicker } from "@/components/deploy-target-picker";
import { isRouteHostname, normalizeHostname } from "@/lib/deploy/wireguard/tunnel-hostname";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    Input
} from "@polaris/ui";

export function TunnelDialog() {
    const t = useTranslations("tunnels");
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [serverId, setServerId] = useState("");
    const [serviceId, setServiceId] = useState("");
    // The server the chosen service runs on, so picking that same server as the
    // public end lets go of it.
    const [serviceTarget, setServiceTarget] = useState<string | null>(null);
    const [hostname, setHostname] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const normalized = normalizeHostname(hostname);
    // Empty is unfinished, not wrong: the field only complains once there is
    // something in it to complain about.
    const hostnameError =
        normalized && !isRouteHostname(normalized) ? t("dialog.hostnameInvalid") : null;
    const ready = Boolean(serverId) && Boolean(serviceId) && Boolean(normalized) && !hostnameError;

    function reset(): void {
        setServerId("");
        setServiceId("");
        setServiceTarget(null);
        setHostname("");
        setError(null);
    }

    async function submit(event: React.FormEvent): Promise<void> {
        event.preventDefault();
        if (!ready || pending) return;
        setPending(true);
        setError(null);
        const reply = await createTunnelAction({
            publicServerId: serverId,
            serviceId,
            hostname: normalized
        });
        setPending(false);
        if (reply.error) {
            setError(reply.error);
            return;
        }
        setOpen(false);
        reset();
        router.refresh();
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (pending) return;
                setOpen(next);
                if (!next) reset();
            }}
        >
            <DialogTrigger asChild>
                <Button size="sm">
                    <Plus />
                    {t("page.create")}
                </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle>{t("dialog.title")}</DialogTitle>
                    <DialogDescription>{t("dialog.description")}</DialogDescription>
                </DialogHeader>
                <form onSubmit={submit} className="flex flex-col gap-3">
                    <Field label={t("dialog.publicServer")} hint={t("dialog.publicHint")}>
                        <DeployTargetPicker
                            scope="mine"
                            value={serverId || null}
                            onValueChange={(value) => {
                                setServerId(value);
                                if (serviceTarget === value) {
                                    setServiceId("");
                                    setServiceTarget(null);
                                }
                            }}
                            placeholder={t("dialog.pickServer")}
                            aria-label={t("dialog.publicServer")}
                            localLabel={(name) => t("dialog.thisMachine", { name })}
                        />
                    </Field>
                    <Field label={t("dialog.service")} hint={t("dialog.serviceHint")}>
                        <ServicePicker
                            value={serviceId || null}
                            onValueChange={(value, service) => {
                                setServiceId(value);
                                setServiceTarget(service?.targetId ?? null);
                            }}
                            excludeTargetId={serverId || undefined}
                            disabled={!serverId}
                            placeholder={t("dialog.pickService")}
                            searchPlaceholder={t("dialog.searchServices")}
                            emptyText={t("dialog.noServices")}
                            aria-label={t("dialog.service")}
                            optionLabel={(service) =>
                                t("dialog.serviceOption", {
                                    service: service.name,
                                    project: service.project
                                })
                            }
                        />
                    </Field>
                    <Field label={t("dialog.hostname")} error={hostnameError}>
                        <Input
                            value={hostname}
                            onChange={(event) => setHostname(event.target.value)}
                            placeholder="app.example.com"
                            autoComplete="off"
                            spellCheck={false}
                            inputMode="url"
                            maxLength={253}
                            aria-invalid={hostnameError ? true : undefined}
                        />
                    </Field>
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                    <div className="flex flex-wrap justify-end gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            disabled={pending}
                            onClick={() => setOpen(false)}
                        >
                            {t("dialog.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!ready || pending} disabled={pending}>
                            {pending ? t("dialog.creating") : t("dialog.create")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function Field({
    label,
    hint,
    error,
    children
}: {
    label: string;
    hint?: string;
    error?: string | null;
    children: React.ReactNode;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-1 text-sm">
            <span>{label}</span>
            {children}
            {error ? <span className="text-xs text-danger">{error}</span> : null}
            {hint && !error ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
        </div>
    );
}
