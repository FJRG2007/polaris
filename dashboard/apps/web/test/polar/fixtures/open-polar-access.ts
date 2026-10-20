/**
 * A Polar access module that lets everybody in and spends whatever the key
 * store hands over - the behaviour a route test is written against when the
 * access policy is not what it is about. The policy itself is asserted in
 * `access.test.ts`.
 */
export async function openPolarAccess() {
    const keys = await import("@/lib/agents/model-keys");
    return {
        // Read on the call, so a test that never reaches a route never loads a session.
        polarCaller: async () => (await import("@/lib/api-session")).apiUser(),
        polarAccessFor: async () => ({ use: true, spend: true, web: true }),
        polarKeySources: (userId: string) => keys.keySourcesFor(userId),
        polarCredentialFor: (...args: Parameters<typeof keys.chatCredentialFor>) =>
            keys.chatCredentialFor(...args)
    };
}
