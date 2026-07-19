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
    assignRole
} from "./roles.js";
export { provisionUser, hasAnyUser, setUserAdmin, type ProvisionInput } from "./provision.js";
export { can, resolveGlobalStatements } from "./authz.js";
export {
    createGroup,
    deleteGroup,
    listGroups,
    getGroupWithMembers,
    addGroupMember,
    removeGroupMember,
    getUserGroupIds,
    type GroupSummary,
    type GroupMemberInfo
} from "./groups.js";
export {
    createPolicy,
    updatePolicy,
    deletePolicy,
    listPolicies,
    getPolicy,
    attachPolicy,
    detachPolicy,
    resolvePrincipalPolicyStatements,
    type PrincipalType,
    type PolicySummary
} from "./policies.js";
