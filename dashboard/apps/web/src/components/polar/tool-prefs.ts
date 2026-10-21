"use client";

/**
 * What this viewer switched off among Polar's tools: web search, single tools,
 * and whole MCP servers. Kept in this browser, as it always was, and read by
 * both the chat (which sends it with every turn) and the settings page (which
 * changes it). A change on one is seen by the other at once, in this tab or
 * another, so the panel never sends a turn with the switches it had before the
 * page changed them.
 *
 * Nothing here is on until somebody switched it off: a viewer who never chose
 * has every tool and web search on.
 */

import { useCallback, useEffect, useState } from "react";
import { connectorServer, type ServedTool } from "@/lib/polar/tool-servers";

/** Whether this viewer left web search on: "off" is the only value that is off. */
export const WEB_KEY = "polar.web";
/** The switch every connector shared before each became its own server: an
 *  "off" here still holds for every connector until one is switched again. */
export const CONNECTORS_KEY = "polar.connectors";
/** The tools this viewer switched off one by one. */
export const TOOLS_OFF_KEY = "polar.toolsOff";
/** The MCP servers this viewer switched off as a whole. */
export const SERVERS_OFF_KEY = "polar.serversOff";

const CHANGED = "polar:tool-prefs";

export interface ToolPrefs {
    webOn: boolean;
    toolsOff: string[];
    serversOff: string[];
    /** The old all-connectors switch left off. */
    connectorsOff: boolean;
}

/** A viewer who never chose. */
export const DEFAULT_TOOL_PREFS: ToolPrefs = {
    webOn: true,
    toolsOff: [],
    serversOff: [],
    connectorsOff: false
};

function read(key: string): string | null {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function write(key: string, value: string | null): void {
    try {
        if (value === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
    } catch {
        // Not kept; this tab still has it until it is closed.
    }
}

function names(raw: string | null): string[] {
    try {
        const kept: unknown = JSON.parse(raw ?? "[]");
        return Array.isArray(kept)
            ? kept.filter((name): name is string => typeof name === "string")
            : [];
    } catch {
        // Unreadable: everything on, as for somebody who never chose.
        return [];
    }
}

export function readToolPrefs(): ToolPrefs {
    return {
        webOn: read(WEB_KEY) !== "off",
        toolsOff: names(read(TOOLS_OFF_KEY)),
        serversOff: names(read(SERVERS_OFF_KEY)),
        connectorsOff: read(CONNECTORS_KEY) === "off"
    };
}

/** The servers that are off, the old all-connectors switch included. */
export function serversOffOf(prefs: ToolPrefs, tools: Record<string, ServedTool>): string[] {
    if (!prefs.connectorsOff) return prefs.serversOff;
    const connectors = Object.values(tools)
        .filter((tool) => tool.connector)
        .map((tool) => connectorServer(tool.connector!));
    return [...new Set([...prefs.serversOff, ...connectors])];
}

/** This viewer's switches, kept in step with every other place that changes
 *  them. */
export function useToolPrefs() {
    const [prefs, setPrefs] = useState<ToolPrefs>(DEFAULT_TOOL_PREFS);
    useEffect(() => {
        const sync = () => setPrefs(readToolPrefs());
        sync();
        window.addEventListener(CHANGED, sync);
        window.addEventListener("storage", sync);
        return () => {
            window.removeEventListener(CHANGED, sync);
            window.removeEventListener("storage", sync);
        };
    }, []);

    const commit = useCallback((next: ToolPrefs) => {
        write(WEB_KEY, next.webOn ? "on" : "off");
        write(TOOLS_OFF_KEY, JSON.stringify(next.toolsOff));
        write(SERVERS_OFF_KEY, JSON.stringify(next.serversOff));
        write(CONNECTORS_KEY, next.connectorsOff ? "off" : null);
        setPrefs(next);
        window.dispatchEvent(new Event(CHANGED));
    }, []);

    const setWeb = (on: boolean) => commit({ ...readToolPrefs(), webOn: on });

    const setTool = (name: string, on: boolean) => {
        const now = readToolPrefs();
        const rest = now.toolsOff.filter((one) => one !== name);
        commit({ ...now, toolsOff: on ? rest : [...rest, name] });
    };

    /** A whole server on or off. The old all-connectors switch is spelled out
     *  per connector first, so switching one back on leaves the others off. */
    const setServer = (server: string, on: boolean, tools: Record<string, ServedTool>) => {
        const now = readToolPrefs();
        const rest = serversOffOf(now, tools).filter((one) => one !== server);
        commit({ ...now, connectorsOff: false, serversOff: on ? rest : [...rest, server] });
    };

    return { prefs, setWeb, setTool, setServer };
}
