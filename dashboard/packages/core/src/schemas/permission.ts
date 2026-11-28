/**
 * One permission as a role, an API key or an access rule stores it: a built-in
 * one, one an installed app registered from its manifest, or one shaped like an
 * app's own that no app registers now. The last is kept, never stripped or
 * refused, and is inert (`hasPermission` grants nothing for it), so a role
 * holding a permission of an app the catalogue later drops still saves.
 */

import { z } from "zod";
import { isAppScopedPermission, isKnownPermission, type Permission } from "../permissions.js";

export const permissionSchema = z
    .string()
    .max(100)
    .refine(
        (value): value is Permission => isKnownPermission(value) || isAppScopedPermission(value),
        "unknown permission"
    );
