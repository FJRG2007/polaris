"use client";

/**
 * Picking the system an install line is for, with each system's own mark.
 *
 * One picker for every install line on the downloads screen, so the extension's
 * and the command line's read the same and remember the same detection. The
 * marks are the official ones `client-marks` already draws for sessions.
 */

import { Select } from "../../index";
import { useEffect, useRef, useState } from "react";
import { SystemMark } from "./client-marks";
import {
    detectPlatform,
    INSTALL_PLATFORMS,
    PLATFORM_LABELS,
    type InstallPlatform
} from "./install-platform";

/**
 * The system a picker starts on: the reader's own, once the browser has said
 * which. Detected in an effect rather than during render - this renders on the
 * server too, where there is no navigator, and seeding from one would have the
 * browser hydrate something the HTML does not contain. A system the reader
 * picked before the detection lands is kept.
 */
export function useInstallPlatform(): [InstallPlatform, (platform: InstallPlatform) => void] {
    const [platform, setPlatform] = useState<InstallPlatform>("linux");
    const picked = useRef(false);
    useEffect(() => {
        if (!picked.current) setPlatform(detectPlatform(navigator.userAgent));
    }, []);
    return [
        platform,
        (next) => {
            picked.current = true;
            setPlatform(next);
        }
    ];
}

export function PlatformSelect({
    value,
    onChange,
    label,
    className,
    platforms = INSTALL_PLATFORMS
}: {
    value: InstallPlatform;
    onChange: (platform: InstallPlatform) => void;
    /** What the picker is for, for a screen reader. */
    label: string;
    className?: string;
    /** The systems offered, when a line exists for only some of them. */
    platforms?: readonly InstallPlatform[];
}) {
    return (
        <Select
            className={className}
            value={value}
            aria-label={label}
            onValueChange={(next) => onChange(next as InstallPlatform)}
            options={platforms.map((platform) => ({
                value: platform,
                label: PLATFORM_LABELS[platform],
                icon: <SystemMark os={PLATFORM_LABELS[platform]} />
            }))}
        />
    );
}
