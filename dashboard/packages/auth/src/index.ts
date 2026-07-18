/**
 * @polaris/auth - authentication and authorization. createAuth() builds the
 * better-auth instance for the app; the roles module resolves what an
 * authenticated user is allowed to do. Request-scoped guards live in the web app
 * because they need its concrete auth instance and request headers.
 */

export { createAuth, type Auth } from "./auth.js";
export {
    seedDefaultRoles,
    getUserPermissions,
    userHasPermission,
    assignRole,
    bootstrapFirstAdmin
} from "./roles.js";
