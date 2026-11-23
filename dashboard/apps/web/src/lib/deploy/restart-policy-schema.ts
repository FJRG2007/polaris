/** The restart policy as a form or an action takes it; shared by both sides. */

import { z } from "zod";

export const RESTART_POLICIES = ["never", "on-failure", "always"] as const;
export const MAX_RESTART_RETRIES = 100;

export const restartPolicySchema = z.object({
    policy: z.enum(RESTART_POLICIES),
    maxRetries: z.number().int().min(1).max(MAX_RESTART_RETRIES)
});
