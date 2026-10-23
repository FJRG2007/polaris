"use client";

/**
 * The pieces of Deploy's new-service dialog that other screens reuse: the
 * template form (the marketplace opens it on one template) and the server
 * picker every source shares. Kept apart from the project view so a screen that
 * only needs the form does not pull in the whole canvas.
 */

import * as deployActions from "./actions";
import { ChevronRight, Loader2 } from "lucide-react";
import type { NamespaceKey } from "@/lib/i18n/types";
import { Button, Input, Select } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useState, useTransition } from "react";
import {
    dbEngineLabel,
    SERVICE_TEMPLATES,
    serviceTemplate,
    type ServiceTemplate
} from "@polaris/core";
import { Field } from "./form-field";
import * as polls from "./deploy-polls";

export interface ServerOption {
    id: string;
    name: string;
}

/**
 * The servers a new service can deploy to (local host + connected SSH hosts),
 * with the first one selected by default - so a single-server setup needs no
 * choice and multi-server setups get an explicit picker.
 */
export function useDeployServers(environmentId: string): {
    servers: ServerOption[];
    serverId: string;
    setServerId: (id: string) => void;
} {
    const [servers, setServers] = useState<ServerOption[]>([]);
    const [serverId, setServerId] = useState("local");
    useEffect(() => {
        // Scoped to the environment being deployed into, so the list is the
        // project owner's machines rather than the machines of whoever happens to
        // be filling the form in.
        void polls
            .deployServers(environmentId)
            .then((list) => {
                setServers(list);
                if (list[0]) setServerId(list[0].id);
            })
            .catch(() => undefined);
    }, [environmentId]);
    return { servers, serverId, setServerId };
}

export function ServerField({
    servers,
    value,
    onChange
}: {
    servers: ServerOption[];
    value: string;
    onChange: (id: string) => void;
}) {
    const t = useTranslations("deploy");
    if (servers.length === 0) return null;
    return (
        <Field label={t("view.server")} hint={t("view.serverHint")}>
            <Select
                value={value}
                onValueChange={onChange}
                options={servers.map((server) => ({ value: server.id, label: server.name }))}
                aria-label={t("view.server")}
            />
        </Field>
    );
}

/** What a template creates besides its own service, in the picker's words. */
function templateExtra(
    template: ServiceTemplate
): { engine: string } | { companion: string } | null {
    if (template.database) return { engine: dbEngineLabel(template.database.engine) };
    if (template.companion) return { companion: template.companion.label };
    return null;
}

/** A one-click service: pick a template, name it, and it deploys with its
 *  volumes and variables already set. */
export function NewTemplateForm({
    environmentId,
    initialTemplateId,
    onDone
}: {
    environmentId: string;
    /** Opens on this template rather than the list: the marketplace picked it. */
    initialTemplateId?: string;
    onDone: () => void;
}) {
    const t = useTranslations("deploy");
    const initial = initialTemplateId ? serviceTemplate(initialTemplateId) : null;
    const [picked, setPicked] = useState<ServiceTemplate | null>(initial);
    const [name, setName] = useState(initial?.name ?? "");
    const [query, setQuery] = useState("");
    const { servers, serverId, setServerId } = useDeployServers(environmentId);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        if (!picked) return;
        setError(null);
        startTransition(async () => {
            const result = await deployActions.createApplicationAction({
                environmentId,
                name: name.trim() || picked.name,
                templateId: picked.id,
                serverId
            });
            if (result.error) setError(result.error);
            else onDone();
        });
    }

    const describe = (template: ServiceTemplate) =>
        t(`view.template.catalog.${template.id}.description` as NamespaceKey<"deploy">);
    const firstRun = (template: ServiceTemplate) =>
        t(`view.template.catalog.${template.id}.firstRun` as NamespaceKey<"deploy">);

    if (!picked) {
        const needle = query.trim().toLowerCase();
        const shown = [...SERVICE_TEMPLATES]
            .sort((a, b) => a.name.localeCompare(b.name))
            .filter(
                (template) =>
                    !needle ||
                    template.name.toLowerCase().includes(needle) ||
                    describe(template).toLowerCase().includes(needle)
            );
        return (
            <div className="flex flex-col gap-2">
                <Input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("view.template.search")}
                    aria-label={t("view.template.search")}
                    autoFocus
                />
                <div className="flex max-h-96 flex-col gap-1 overflow-y-auto overscroll-contain">
                    {shown.length === 0 && (
                        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                            {t("view.template.none")}
                        </p>
                    )}
                    {shown.map((template) => (
                        <button
                            key={template.id}
                            type="button"
                            onClick={() => {
                                setPicked(template);
                                setName(template.name);
                            }}
                            className="group flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted"
                        >
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium text-foreground">
                                    {template.name}
                                    {(() => {
                                        const extra = templateExtra(template);
                                        if (!extra) return null;
                                        return (
                                            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                                                {"engine" in extra
                                                    ? t("view.template.withEngine", {
                                                          engine: extra.engine
                                                      })
                                                    : t("view.template.withCompanion", {
                                                          companion: extra.companion
                                                      })}
                                            </span>
                                        );
                                    })()}
                                </span>
                                <span
                                    className="block truncate text-xs text-muted-foreground"
                                    title={describe(template)}
                                >
                                    {describe(template)}
                                </span>
                            </span>
                            <ChevronRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                        </button>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
                {picked.description} <span className="font-mono text-xs">{picked.image}</span>
            </p>
            <Field label={t("view.name")}>
                <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={picked.name}
                />
            </Field>
            <ServerField servers={servers} value={serverId} onChange={setServerId} />
            {picked.database && (
                <p className="text-xs text-muted-foreground">
                    {t("view.template.createsDatabase", {
                        engine: dbEngineLabel(picked.database.engine)
                    })}
                </p>
            )}
            {picked.companion && (
                <p className="text-xs text-muted-foreground">
                    {t("view.template.createsCompanion", { companion: picked.companion.label })}
                </p>
            )}
            <p className="text-xs text-muted-foreground">
                {firstRun(picked)}
                {picked.secrets.length > 0 && t("view.template.secrets")}
                {picked.prepare?.length ? t("view.template.setup") : ""}
            </p>
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
                {!initial && (
                    <Button
                        variant="ghost"
                        className="mr-auto"
                        onClick={() => setPicked(null)}
                        disabled={pending}
                    >
                        {t("view.template.other")}
                    </Button>
                )}
                <Button onClick={submit} disabled={pending}>
                    {pending && <Loader2 className="size-4 animate-spin" />} {t("view.deploy")}
                </Button>
            </div>
        </div>
    );
}
