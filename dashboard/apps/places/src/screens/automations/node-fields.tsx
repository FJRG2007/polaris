"use client";

/**
 * The settings of a Places node in the central automation editor: the same
 * cards the Places editor draws for the block it stands for - target pickers
 * with sets, rooms and floors, the setting picker, sun, "for at least", ranges
 * and "Triggered by" - so a moved automation is changed with the fields it was
 * written with.
 *
 * A node's config is the Places block without its id (the node's id is it) and
 * with its place, so the card edits `{ ...config, id }` and hands back the same
 * minus the id.
 */

import { useEffect, useMemo, useState } from "react";
import { Select, Skeleton } from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";
import * as actions from "./actions";
import * as fields from "./flow-fields";
import { usePlacesT } from "../use-places-t";
import { RoomsProvider } from "./add-block";
import * as auto from "../../lib/automation-kinds";
import * as nodes from "../../lib/automation-nodes";
import type { DeviceView } from "../../lib/device-kinds";
import type { RoomView } from "../../lib/room-kinds";
import { ConditionGroupCard, StepCard, TriggerCard } from "./automation-editor";

const { runAction } = hostUi.runAction;

/** What the central editor hands a Places node's fields. */
export interface HomeNodeFieldsProps {
    readonly node: { readonly id: string; readonly type: string; readonly config?: unknown };
    readonly setConfig: (config: unknown) => void;
    readonly disabled?: boolean;
}

interface Listing {
    readonly placeId: string;
    readonly devices: DeviceView[];
    readonly rooms: RoomView[];
    readonly siblings: { id: string; name: string }[];
}

const NO_ROOMS: RoomView[] = [];

/** The config a card's block is saved as: the block without its id. */
function configOf<B extends { id: string }>(block: B, placeId: unknown): Record<string, unknown> {
    const { id: _id, ...rest } = block;
    return { ...rest, placeId };
}

export function HomeNodeFields({ node, setConfig, disabled = false }: HomeNodeFieldsProps) {
    const t = usePlacesT();
    const [listing, setListing] = useState<Listing | null>(null);
    const [error, setError] = useState("");

    const config = (node.config ?? {}) as Record<string, unknown>;
    const named = typeof config.placeId === "string" ? config.placeId : null;

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result = await runAction(() => actions.nodeContextAction(named), setError);
            if (cancelled || !result) return;
            if (result.error) {
                setError(result.error);
                return;
            }
            if (!result.context) return;
            setListing({
                placeId: result.context.placeId,
                devices: result.context.devices,
                rooms: result.context.rooms ?? NO_ROOMS,
                siblings: result.context.siblings
            });
        })();
        return () => {
            cancelled = true;
        };
    }, [named]);

    const devices = listing?.devices ?? [];
    const byId = useMemo(() => new Map(devices.map((device) => [device.id, device])), [devices]);

    if (error && !listing) {
        return (
            <p role="alert" className="text-sm text-danger">
                {error}
            </p>
        );
    }
    if (!listing) return <Skeleton className="h-24 w-full" />;

    const placeId = named ?? listing.placeId;
    const watched = devices.filter(fields.watchable);
    const sensors = devices.filter((device) => auto.measures(device.kind));
    const operable = devices.filter(fields.operable);
    const path: (string | number)[] = [];
    const ignore = () => undefined;

    let body: React.ReactNode = null;
    if (node.type.startsWith(`${nodes.NODE_APP}.trigger.`)) {
        // Edited as it stands, even half filled in; the publish check says what is missing.
        const trigger = { ...config, id: node.id } as unknown as auto.Trigger;
        body = (
            <TriggerCard
                plain
                trigger={trigger}
                path={path}
                devices={watched}
                sensors={sensors}
                byId={byId}
                disabled={disabled}
                onChange={(next) => setConfig(configOf(next, placeId))}
                onRemove={ignore}
            />
        );
    } else if (node.type === nodes.CONDITION_NODE_TYPE) {
        const groups = (Array.isArray(config.groups) ? config.groups : []) as auto.ConditionGroup[];
        const match = config.match === "any" ? "any" : "all";
        const setGroups = (next: auto.ConditionGroup[]) =>
            setConfig({ ...config, placeId, groups: next });
        body = (
            <div className="flex flex-col gap-3">
                {groups.length > 1 && (
                    <Select
                        value={match}
                        disabled={disabled}
                        aria-label={t("automations.nodeFields.groupsMatch")}
                        options={[
                            { value: "all", label: t("automations.editor.allOf") },
                            { value: "any", label: t("automations.editor.anyOf") }
                        ]}
                        onValueChange={(value) => setConfig({ ...config, match: value })}
                    />
                )}
                {groups.map((group, index) => (
                    <ConditionGroupCard
                        key={index}
                        plain
                        group={group}
                        path={[index]}
                        devices={watched}
                        sensors={sensors}
                        byId={byId}
                        disabled={disabled}
                        attempted={false}
                        onChange={(next) =>
                            setGroups(groups.map((entry, at) => (at === index ? next : entry)))
                        }
                        onRemove={() =>
                            groups.length > 1 && setGroups(groups.filter((_, at) => at !== index))
                        }
                    />
                ))}
            </div>
        );
    } else if (node.type.startsWith(`${nodes.NODE_APP}.action.`)) {
        const step = { ...config, id: node.id } as unknown as auto.Step;
        body = (
            <StepCard
                plain
                number={1}
                step={step}
                path={path}
                watched={watched}
                operable={operable}
                canControl
                byId={byId}
                siblings={listing.siblings}
                disabled={disabled}
                onChange={(next) => setConfig(configOf(next, placeId))}
                onRemove={ignore}
            />
        );
    }

    return <RoomsProvider value={listing.rooms ?? NO_ROOMS}>{body}</RoomsProvider>;
}
