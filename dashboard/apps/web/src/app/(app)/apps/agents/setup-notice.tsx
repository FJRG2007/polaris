import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { providersFor } from "@/lib/agents/model-keys";
import { getGithubStatus, githubPermissionGap } from "@/lib/github-service";
import { permissionList } from "@/lib/integrations/github-permission-copy";
import { getTranslations } from "@/lib/i18n/request";

/**
 * The one thing standing between here and a working agent, when there is one.
 *
 * Ordered by what has to be true first, and only ever showing the earliest
 * missing piece: a list of four things nobody has done yet reads as a chore,
 * while one sentence with one link reads as the next step.
 */
export async function SetupNotice() {
    const user = await requirePermission("agents.read");
    const t = await getTranslations("agents");
    const link = (href: string) =>
        function NoticeLink(chunks: React.ReactNode) {
            return (
                <Link key={href} href={href} className="underline">
                    {chunks}
                </Link>
            );
        };
    const [github, gap, providers] = await Promise.all([
        getGithubStatus().catch(() => null),
        githubPermissionGap().catch(() => ({
            installations: [],
            reviewUrl: null,
            appMissing: [],
            appPermissionsUrl: null
        })),
        providersFor(user.id).catch(() => [])
    ]);

    if (github?.method !== "app") {
        return (
            <Notice>{t.rich("notice.needsApp", { link: link("/admin/integrations") })}</Notice>
        );
    }

    // An App that gained permissions does not gain them on anything it is already
    // installed on until the owner accepts. Every dispatch fails with an opaque
    // 403 until then.
    //
    // Addressed to an administrator, and only to one. Accepting is done in
    // GitHub's own settings by whoever owns the installation, which in a Polaris
    // deployment is the person who connected it - so to everybody else this was a
    // wall of instructions for a page they cannot open, about an App they did not
    // install, on an account that is not theirs. They still get told their runs
    // are refused, because a run failing for no stated reason is worse; they just
    // do not get handed a chore they cannot do.
    // The step before the acceptance, and the one nobody was being told about.
    //
    // GitHub is sent the permission set once, in the manifest that creates the
    // App, and publishes no way to change it afterwards. So an App created before
    // a permission was added to `APP_PERMISSIONS` does not ask for it, no
    // installation is holding a request for it, and the acceptance screen below
    // has nothing on it. This screen nevertheless said "so-and-so has not granted
    // Deployments" and sent people to press a button that was not there - every
    // few minutes, forever, with no way to make it stop.
    //
    // Naming the real first step is the fix. It is genuinely the owner's to do
    // and genuinely by hand, which puts it in the same class as a DNS record at
    // a registrar: not ours, so say it precisely, with the address and the exact
    // rows to set.
    if (gap.appMissing.length > 0) {
        if (!user.isAdmin) {
            return (
                <Notice>{t("notice.missingPermission")}</Notice>
            );
        }
        return (
            <Notice>
                <p>{t("notice.notAsked", { permissions: permissionList(gap.appMissing) })}</p>
                {gap.appPermissionsUrl ? (
                    <p className="mt-2">
                        {t.rich("notice.setOn", {
                            permissions: permissionList(gap.appMissing),
                            url: gap.appPermissionsUrl,
                            link: (chunks) => (
                                <a
                                    key="settings"
                                    href={gap.appPermissionsUrl ?? undefined}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="break-all underline"
                                >
                                    {chunks}
                                </a>
                            )
                        })}
                    </p>
                ) : null}
                <p className="mt-2 opacity-80">{t("notice.clearsItself")}</p>
            </Notice>
        );
    }

    if (gap.installations.length > 0) {
        if (!user.isAdmin) {
            return (
                <Notice>{t("notice.awaitingAdmin")}</Notice>
            );
        }
        return (
            <Notice>
                <p>{t("notice.holding")}</p>
                <ul className="mt-2 flex flex-col gap-1.5">
                    {gap.installations.map((row) => (
                        <li key={row.login}>
                            {t.rich("notice.notGranted", {
                                login: row.login,
                                permissions: permissionList(row.missing),
                                name: (chunks) => (
                                    <span key="login" className="font-medium">
                                        {chunks}
                                    </span>
                                )
                            })}{" "}
                            {row.reviewUrl ? (
                                <>
                                    {t("notice.acceptStep")} {t("notice.on")}{" "}
                                    {/* The address, written out rather than hidden
                                        behind a word. It is the page an acceptance
                                        actually happens on, it is per-installation
                                        and unguessable, and somebody signed in to
                                        GitHub as another account has to be able to
                                        take it to the browser that is. */}
                                    <a
                                        href={row.reviewUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="break-all underline"
                                    >
                                        {row.reviewUrl}
                                    </a>
                                </>
                            ) : (
                                // Only for a deployment holding neither the App's
                                // page nor its name, which is a deployment with no
                                // App. Naming the page beats a link that 404s.
                                <span>{t("notice.openOnGithub")}</span>
                            )}
                        </li>
                    ))}
                </ul>
                <p className="mt-2 opacity-80">{t("notice.clearsItself")}</p>
            </Notice>
        );
    }

    if (providers.length === 0) {
        return <Notice>{t.rich("notice.noProvider", { link: link("/account/ai-keys") })}</Notice>;
    }

    return null;
}

function Notice({ children }: { children: React.ReactNode }) {
    return (
        <div className="mb-4 rounded-lg border border-warning-edge bg-warning-soft px-4 py-3 text-sm text-warning-ink">
            {children}
        </div>
    );
}

