/**
 * Whether Polaris turns a server's automatic security updates on by itself: once,
 * and only while nobody has ever chosen for that server. A person's "off" -
 * before or after Polaris armed it - is kept for good.
 */
export function armsUpdates(
    setting: { readonly updatesChoice: string | null; readonly updatesArmedAt: Date | null } | null
): boolean {
    return !setting || (setting.updatesChoice === null && setting.updatesArmedAt === null);
}
