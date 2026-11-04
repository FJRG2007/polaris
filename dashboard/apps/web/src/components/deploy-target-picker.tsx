"use client";

/**
 * Pickers over deploy servers and services, read a page at a time and searched
 * on the server, so an account with thousands of either opens them as fast as
 * one with five. What a screen needs left out is part of the request, never a
 * list narrowed in the browser.
 */

import * as ui from "@polaris/ui";
import { useCallback } from "react";
import { usePaged } from "@/components/paged-picker";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    listDeployTargetOptionsAction,
    listServiceOptionsAction
} from "@/app/(app)/deploy-target-options-actions";
import type {
    DeployTargetOption,
    DeployTargetScope,
    ServiceOption
} from "@/lib/deploy-target-options-schema";

interface PickerProps<T> {
    value: string | null;
    onValueChange: (id: string, item: T | null) => void;
    /** The chosen one's name, when the screen already has it. */
    selectedLabel?: string;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    id?: string;
    "aria-label"?: string;
}

/** One deploy server; this machine is labelled with `localLabel` when given. */
export function DeployTargetPicker({
    scope,
    projectId,
    localLabel,
    placeholder,
    ...rest
}: PickerProps<DeployTargetOption> & {
    scope: DeployTargetScope;
    /** The project whose owner's servers scope `project` reads. */
    projectId?: string;
    localLabel?: (name: string) => string;
}) {
    const t = useTranslations("components");
    const { load, resolve, key } = usePaged<DeployTargetOption>(
        listDeployTargetOptionsAction,
        projectId ? { scope, projectId } : { scope }
    );
    const label = useCallback(
        (target: DeployTargetOption) =>
            target.local && localLabel ? localLabel(target.name) : target.name,
        [localLabel]
    );
    return (
        <ui.AsyncSelect<DeployTargetOption>
            {...rest}
            load={load}
            resolve={resolve}
            cacheKey={`deploy-targets:${key}`}
            itemValue={(target) => target.id}
            itemLabel={label}
            placeholder={placeholder ?? t("serverPicker.placeholder")}
            searchPlaceholder={t("deployTargetPicker.search")}
            emptyText={t("serverPicker.empty")}
        />
    );
}

/** One of the caller's services, optionally leaving out one server's. */
export function ServicePicker({
    excludeTargetId,
    optionLabel,
    placeholder,
    searchPlaceholder,
    emptyText,
    ...rest
}: PickerProps<ServiceOption> & {
    excludeTargetId?: string;
    searchPlaceholder?: string;
    emptyText?: string;
    /** How a service is named in the list, given its project. */
    optionLabel?: (service: ServiceOption) => string;
}) {
    const t = useTranslations("components");
    const { load, resolve, key } = usePaged<ServiceOption>(
        listServiceOptionsAction,
        excludeTargetId ? { excludeTargetId } : {}
    );
    return (
        <ui.AsyncSelect<ServiceOption>
            {...rest}
            load={load}
            resolve={resolve}
            cacheKey={`services:${key}`}
            itemValue={(service) => service.id}
            itemLabel={optionLabel ?? ((service) => service.name)}
            itemDetail={(service) => service.project}
            placeholder={placeholder ?? t("servicePicker.placeholder")}
            searchPlaceholder={searchPlaceholder ?? t("servicePicker.search")}
            emptyText={emptyText ?? t("servicePicker.empty")}
        />
    );
}
