"use client";

/**
 * A panel's devices as one list, for a wall with more of them than cards can
 * show: a search, a heading per room, and each device on a line with the one
 * control a line holds - the room card's own. Only the rows on screen are
 * drawn (`visibleRange`), so five hundred devices cost what twenty do.
 */

import { Input } from "@polaris/ui";
import { Search } from "lucide-react";
import { usePlacesT } from "../use-places-t";
import type { CardActs } from "./panel-cards";
import { BatteryMeter } from "../devices/battery-meter";
import type { DeviceView } from "../../lib/device-kinds";
import { DeviceControls, DeviceIcon } from "../devices/device-panel";
import { listRows, visibleRange, type ListRoom } from "../../lib/panel-list";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

/** Every row is this tall, in pixels: a finger's height and a control's. */
const ROW_PX = 56;

export function PanelDeviceList({
    devices,
    rooms,
    acts
}: {
    devices: readonly DeviceView[];
    rooms: readonly ListRoom[];
    acts: CardActs;
}) {
    const t = usePlacesT();
    const [query, setQuery] = useState("");
    const [scrollTop, setScrollTop] = useState(0);
    const [viewport, setViewport] = useState(600);
    const box = useRef<HTMLDivElement>(null);
    const rows = useMemo(() => listRows(devices, rooms, query), [devices, rooms, query]);
    const { start, end } = visibleRange(scrollTop, viewport, ROW_PX, rows.length);
    const shown = rows.filter((row) => row.kind === "device").length;

    useEffect(() => {
        const element = box.current;
        if (!element) return;
        const measure = () => setViewport(element.clientHeight);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    // A new search starts at the top: the old position may be past its end.
    useEffect(() => {
        if (box.current) box.current.scrollTop = 0;
        setScrollTop(0);
    }, [query]);

    return (
        <div className="flex min-h-0 flex-col gap-3">
            <div className="flex min-w-0 items-center gap-3">
                <div className="relative min-w-0 flex-1 sm:max-w-sm">
                    <Search
                        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                        aria-hidden
                    />
                    <Input
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("panelList.search")}
                        aria-label={t("panelList.search")}
                        className="h-11 pl-9"
                    />
                </div>
                <span className="shrink-0 text-sm text-muted-foreground" role="status">
                    {t("panelList.count", { count: shown })}
                </span>
            </div>
            <div
                ref={box}
                onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
                className="relative h-[calc(100dvh-10rem)] min-h-64 overflow-y-auto overscroll-contain rounded-xl border border-border bg-card"
                role="list"
                aria-label={t("panelList.label")}
            >
                {rows.length === 0 ? (
                    <p className="p-6 text-center text-sm text-muted-foreground">
                        {query ? t("panelList.noMatch") : t("panelList.empty")}
                    </p>
                ) : (
                    <div style={{ height: rows.length * ROW_PX }} className="relative">
                        {rows.slice(start, end).map((row, offset) => {
                            const at = {
                                top: (start + offset) * ROW_PX,
                                height: ROW_PX
                            } as CSSProperties;
                            if (row.kind === "group") {
                                const label = row.room
                                    ? row.floor
                                        ? t("panelList.roomOnFloor", {
                                              room: row.room,
                                              floor: row.floor
                                          })
                                        : row.room
                                    : t("panelList.noRoom");
                                return (
                                    <div
                                        key={row.key}
                                        style={at}
                                        role="presentation"
                                        className="absolute inset-x-0 flex min-w-0 items-end gap-2 border-b border-border bg-muted/40 px-4 pb-2"
                                    >
                                        <span
                                            className="min-w-0 flex-1 truncate text-sm font-medium"
                                            title={label}
                                        >
                                            {label}
                                        </span>
                                        <span className="shrink-0 text-xs text-muted-foreground">
                                            {t("panelList.count", { count: row.count })}
                                        </span>
                                    </div>
                                );
                            }
                            const device = row.device;
                            return (
                                <div
                                    key={row.key}
                                    style={at}
                                    role="listitem"
                                    className="absolute inset-x-0 flex min-w-0 items-center gap-3 overflow-hidden border-b border-border/60 px-4"
                                >
                                    <DeviceIcon
                                        kind={device.kind}
                                        className="size-5 shrink-0 text-muted-foreground"
                                    />
                                    <span
                                        className="min-w-0 flex-1 truncate text-sm"
                                        title={device.name}
                                    >
                                        {device.name}
                                    </span>
                                    <BatteryMeter device={device} />
                                    <div className="flex shrink-0 items-center">
                                        <DeviceControls
                                            device={device}
                                            canControl={acts.canControl}
                                            busy={
                                                acts.busy?.id === device.id
                                                    ? acts.busy.action
                                                    : null
                                            }
                                            onAct={(action, command) =>
                                                acts.onAct(device, action, command)
                                            }
                                        />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
