"use client";

/**
 * Picking the system an install line is for, with each system's own mark.
 *
 * One picker for every install line on the downloads screen, so the extension's
 * and the command line's read the same and remember the same detection. The
 * marks are the official ones `client-marks` already draws for sessions.
 */

import { Select } from "@polaris/ui";
import { SystemMark } from "@/components/client-marks";
import { INSTALL_PLATFORMS, PLATFORM_LABELS, type InstallPlatform } from "@/lib/install-platform";

export function PlatformSelect({
    value,
    onChange,
    label,
    className
}: {
    value: InstallPlatform;
    onChange: (platform: InstallPlatform) => void;
    /** What the picker is for, for a screen reader. */
    label: string;
    className?: string;
}) {
    return (
        <Select
            className={className}
            value={value}
            aria-label={label}
            onValueChange={(next) => onChange(next as InstallPlatform)}
            options={INSTALL_PLATFORMS.map((platform) => ({
                value: platform,
                label: PLATFORM_LABELS[platform],
                icon: <SystemMark os={PLATFORM_LABELS[platform]} />
            }))}
        />
    );
}
