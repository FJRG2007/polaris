/**
 * Inputs of linking and managing devices. Every one is validated before use.
 */

import { z } from "zod";

const id = z.string().uuid();
const name = z.string().trim().min(1).max(60);

export const approveDeviceInput = z.object({ userCode: z.string().trim().min(1).max(20), venueId: id, name });
export const renameDeviceInput = z.object({ id, name });
export const deviceOnly = z.object({ id });
/** What the device itself sends: start a link, or poll it with its secret. */
export const linkRequest = z.discriminatedUnion("step", [
    z.object({ step: z.literal("start") }),
    z.object({ step: z.literal("poll"), deviceCode: z.string().min(20).max(100) })
]);
