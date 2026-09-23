/**
 * Sizes in whatever unit the person is thinking in.
 *
 * Polaris stores one unit per setting - megabytes here, bytes there - and that is
 * the right thing for the code and the wrong thing to make somebody type. A four
 * gigabyte limit typed as 4096 is a number to work out before it can be entered
 * and a number to work out again to check it, and the mistakes it invites are
 * factor-of-1024 mistakes: an upload limit set to a thousandth of what was meant,
 * found later by somebody who could not send a photograph.
 *
 * So the field takes a number and a unit, and this converts. The stored value
 * does not change, which matters more than it looks: every limit already written
 * down, every API that reads one, and every test that pins one keeps meaning
 * exactly what it meant.
 *
 * Binary units throughout - 1 KB is 1024 bytes - because that is what the things
 * being limited are measured in: a disk quota, a file on disk, a container's
 * memory. Labelled the way people write them rather than as KiB/MiB, which is
 * correct and is not what anybody types.
 */

export const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export type SizeUnit = (typeof SIZE_UNITS)[number];

/** How many bytes one of each unit is. */
export function unitBytes(unit: SizeUnit): number {
    return 1024 ** SIZE_UNITS.indexOf(unit);
}

/** A number and a unit, as bytes. */
export function bytesOf(value: number, unit: SizeUnit): number {
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * unitBytes(unit));
}

/** A number and a unit, in some other unit - which is what a field does when it
 *  hands its value back to a setting stored in megabytes. */
export function convertSize(value: number, from: SizeUnit, to: SizeUnit): number {
    if (!Number.isFinite(value)) return 0;
    return (value * unitBytes(from)) / unitBytes(to);
}

/**
 * The unit a size is most readable in, and the size in it.
 *
 * What a field opens on: 4096 MB is shown as 4 GB, and 1536 MB stays in MB
 * because 1.5 GB typed back is a rounding argument nobody asked for. So the
 * biggest unit the value is a whole number of, and never bigger than the value
 * really is.
 */
export function readableSize(value: number, stored: SizeUnit): { value: number; unit: SizeUnit } {
    const bytes = bytesOf(value, stored);
    if (bytes <= 0) return { value: 0, unit: stored };
    // Never below the unit the setting is stored in: a limit kept in megabytes
    // has no way to express 900 KB, and offering it would be a field that loses
    // what was typed into it.
    const floor = SIZE_UNITS.indexOf(stored);
    let best = floor;
    for (let index = SIZE_UNITS.length - 1; index > floor; index -= 1) {
        const size = unitBytes(SIZE_UNITS[index] as SizeUnit);
        if (bytes % size === 0) {
            best = index;
            break;
        }
    }
    const unit = SIZE_UNITS[best] as SizeUnit;
    return { value: bytes / unitBytes(unit), unit };
}

/** The units a field may offer for a setting stored in this one: that unit and
 *  everything above it, because anything smaller cannot be stored. */
export function unitsFrom(stored: SizeUnit): SizeUnit[] {
    return SIZE_UNITS.slice(SIZE_UNITS.indexOf(stored)) as SizeUnit[];
}
