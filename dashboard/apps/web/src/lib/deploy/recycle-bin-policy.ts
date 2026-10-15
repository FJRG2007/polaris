/**
 * The shape of a recycle bin policy, shared by the settings form and the server
 * so both check a value the same way. No database here: the form imports it.
 */

import { z } from "zod";

export const DEFAULT_BIN_DAYS = 30;
export const MIN_BIN_DAYS = 1;
export const MAX_BIN_DAYS = 365;
export const binDaysSchema = z.coerce.number().int().min(MIN_BIN_DAYS).max(MAX_BIN_DAYS);
export const binPolicySchema = z.object({ enabled: z.boolean(), days: binDaysSchema });

export type BinPolicy = z.infer<typeof binPolicySchema>;
