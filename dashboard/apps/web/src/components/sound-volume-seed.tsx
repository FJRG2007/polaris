"use client";

/**
 * Hands the account's sound volume to the sound modules, which are plain
 * functions a hook cannot reach, and keeps following a volume changed in another
 * tab - without a listener, a tab with no settings screen open would go on
 * playing at the old one. Renders nothing.
 */

import { useEffect } from "react";
import { useSessionScope } from "@/components/session-scope";
import { adoptSoundVolume, onSoundVolumeChange } from "@/lib/notification-sound";

export function SoundVolumeSeed({ volume }: { volume: number }) {
    // Whose volume it is, so a second account signed in beside this one in
    // another tab does not hand this one its level.
    const account = useSessionScope();
    useEffect(() => adoptSoundVolume(volume, account), [volume, account]);
    useEffect(() => onSoundVolumeChange(() => undefined), []);
    return null;
}
