"use client";

/**
 * The desktop app's voice widget: the call's people, over every window on the
 * computer while a call is on - a game included - the way a voice app's
 * in-game overlay shows them.
 *
 * The call tells the app who is in it and who is speaking, at most ten times
 * a second and only when something changed; the widget's mute, deafen and
 * leave come back here and do what the room's own buttons do. Bound by
 * whatever holds the call, beside its keys (`call-hotkeys`), so it follows the
 * call across Polaris rather than the screen that draws the room.
 */

import { useEffect, useRef } from "react";
import type { CallState } from "./call-state";
import { desktopBridge, type DesktopVoiceState } from "@/lib/desktop-bridge";

/** The fastest the widget is told anything: a speaking ring every 100 ms. */
export const VOICE_STATE_INTERVAL_MS = 100;
/** The most people the app takes; it draws fewer and counts the rest. */
const MAX_PEOPLE = 50;

type VoiceCall = Pick<
    CallState,
    "meeting" | "participantId" | "speaking" | "states" | "micOn" | "deafened"
>;

/** What the widget draws for this call: everybody admitted, the reader first. */
export function voiceWidgetState(call: VoiceCall): DesktopVoiceState {
    const admitted = (call.meeting?.participants ?? []).filter(
        (person) => person.admission === "admitted"
    );
    const self = admitted.find((person) => person.id === call.participantId);
    const others = admitted.filter((person) => person.id !== call.participantId);
    const participants = [
        ...(self
            ? [
                  {
                      id: self.id,
                      name: self.name.slice(0, 120),
                      speaking: call.speaking.has(self.id) && call.micOn,
                      muted: !call.micOn,
                      deafened: call.deafened
                  }
              ]
            : []),
        ...others.map((person) => {
            const state = call.states.get(person.id);
            return {
                id: person.id,
                name: person.name.slice(0, 120),
                speaking: call.speaking.has(person.id),
                muted: state?.muted ?? false,
                deafened: state?.deafened ?? false
            };
        })
    ].slice(0, MAX_PEOPLE);
    return { participants, selfMuted: !call.micOn, selfDeafened: call.deafened };
}

export function useDesktopVoiceWidget(
    call: VoiceCall & { readonly toggleMic: () => void; readonly toggleDeafen: () => void },
    active: boolean,
    leave: () => void
): void {
    const latest = useRef({ call, leave });
    latest.current = { call, leave };
    /** What was sent last, so an unchanged call sends nothing. */
    const sent = useRef<string | null>(null);
    const lastAt = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // The widget's buttons, heard for the whole of the call.
    useEffect(() => {
        const desktop = desktopBridge();
        if (!active || !desktop?.setVoiceState || !desktop.onVoiceAction) return;
        const stop = desktop.onVoiceAction((action) => {
            if (action === "mic") latest.current.call.toggleMic();
            else if (action === "deafen") latest.current.call.toggleDeafen();
            else latest.current.leave();
        });
        return () => {
            stop();
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            sent.current = null;
            void desktop.setVoiceState?.(null).catch(() => false);
        };
    }, [active]);

    // The call as it is now, at most every interval, and nothing when unchanged.
    const state = active ? JSON.stringify(voiceWidgetState(call)) : null;
    useEffect(() => {
        const desktop = desktopBridge();
        if (state === null || !desktop?.setVoiceState) return;
        const send = () => {
            timer.current = null;
            const now = JSON.stringify(voiceWidgetState(latest.current.call));
            if (now === sent.current) return;
            sent.current = now;
            lastAt.current = Date.now();
            void desktop.setVoiceState?.(JSON.parse(now) as DesktopVoiceState).catch(() => false);
        };
        if (state === sent.current || timer.current) return;
        const wait = lastAt.current + VOICE_STATE_INTERVAL_MS - Date.now();
        if (wait <= 0) send();
        else timer.current = setTimeout(send, wait);
    }, [state]);
}
