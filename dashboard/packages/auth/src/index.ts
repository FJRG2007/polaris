/**
 * @polaris/auth - authentication and authorization. createAuth() builds the
 * better-auth instance for the app; the roles module resolves what an
 * authenticated user is allowed to do. Request-scoped guards live in the web app
 * because they need its concrete auth instance and request headers.
 */

export {
    createAuth,
    createRequestAuth,
    TRUST_DEVICE_COOKIE_NAMES,
    type Auth,
    type RequestAuth
} from "./auth.js";
export {
    seedDefaultRoles,
    getUserPermissions,
    userHasPermission,
    assignRole
} from "./roles.js";
export { provisionUser, hasAnyUser, setUserAdmin, type ProvisionInput } from "./provision.js";
export {
    updateUserProfile,
    changeUserPassword,
    listUserEmails,
    addUserEmail,
    removeUserEmail,
    setUserEmailRecovery,
    promoteUserEmail,
    MAX_ALTERNATE_EMAILS,
    type UserEmailView
} from "./account.js";
export { can, resolveGlobalStatements, usersWithPermission } from "./authz.js";
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
    getUserSecurity,
    updateSessionLimits,
    setLoginApprovalRequired,
    setTwoFactorPreferences,
    beginSessionRotation,
    consumeSessionRotation,
    setQuickPin,
    clearQuickPin,
    verifyQuickPin,
    verifyAccountPassword,
    confirmAccountPassword,
    passwordConfirmed,
    clearPasswordConfirmation,
    listSecurityQuestions,
    setSecurityQuestions,
    clearSecurityQuestions,
    verifySecurityAnswers,
    resetUserPassword,
    updateSignInRules,
    updateEnforcedRules,
    getEnforcedRules,
    type UserSecuritySettings
} from "./security.js";
export { carrySignInRecord, noteSecondFactor, noteSignIn, takeSignInRecord } from "./sign-in-record.js";
export {
    openDeviceCode,
    claimDeviceCode,
    decideDeviceCode,
    exchangeDeviceCode,
    type DeviceCodeIssued,
    type DeviceExchange,
    type IssuedCookie
} from "./device-login.js";
export {
    verifyTotpForSession,
    twoFactorEnabled,
    backupCodesRemaining,
    regenerateBackupCodes,
    adoptTrustedDevice,
    countTrustedDevices,
    currentTrustedDevice,
    listTrustedDevices,
    revokeTrustedDevice,
    revokeTrustedDevices,
    type DeviceOrigin,
    type TrustedDeviceView
} from "./two-factor.js";
export {
    accountDeviceStanding,
    sessionDeviceStanding,
    rememberAccountDevice,
    newDeviceWaitMessage,
    setNewDeviceGrace,
    type DeviceStanding
} from "./devices.js";
export {
    getUserPhone,
    setUserPhone,
    removeUserPhone,
    issuePhoneCode,
    verifyPhoneCode,
    type UserPhoneView
} from "./phone.js";
export {
    listAccessGroups,
    createAccessGroup,
    updateAccessGroup,
    deleteAccessGroup,
    resolveSignInRules,
    resolveEnforcedRules,
    type AccessGroupView
} from "./access-groups.js";
export {
    createApiKey,
    listApiKeys,
    revokeApiKey,
    deleteApiKey,
    verifyApiKey,
    touchApiKey,
    scopesAvailableTo,
    type ApiKeyView,
    type VerifiedApiKey
} from "./api-keys.js";
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
