import Link from "next/link";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import {
    Activity,
    EyeOff,
    Flag,
    Megaphone,
    Radio,
    Stethoscope,
    Store,
    Trash2,
    Award,
    Blocks,
    Bot,
    Building2,
    ChevronRight,
    ClipboardCheck,
    Gauge,
    Globe,
    HardDrive,
    IdCard,
    Mail,
    MessageSquare,
    Scale,
    ScanSearch,
    Settings,
    RefreshCw,
    PartyPopper,
    ShieldCheck,
    KeyRound,
    SlidersHorizontal,
    Sparkles,
    Users,
    UsersRound,
    Wallet
} from "lucide-react";

/**
 * The Management app's home: one card per administration screen, under the same
 * headings as the app's rail areas, so the overview and the rail agree on where
 * a screen lives. Each card's words are `overview.sections.<key>` and each
 * heading's `overview.groups.<key>` in the `admin` catalog.
 */
const GROUPS = [
    {
        key: "audit",
        sections: [
            { key: "activity", href: "/admin/activity", icon: Activity },
            { key: "evidence", href: "/admin/evidence", icon: ClipboardCheck }
        ]
    },
    {
        key: "people",
        sections: [
            { key: "users", href: "/admin/users", icon: Users },
            { key: "privacy", href: "/admin/privacy", icon: EyeOff },
            { key: "groups", href: "/admin/groups", icon: UsersRound },
            { key: "organizations", href: "/admin/organizations", icon: Building2 },
            { key: "roles", href: "/admin/roles", icon: IdCard },
            { key: "policies", href: "/admin/policies", icon: Scale },
            { key: "security", href: "/admin/security", icon: ShieldCheck },
            { key: "images", href: "/admin/security/scans", icon: ScanSearch },
            { key: "sso", href: "/admin/sso", icon: KeyRound },
            { key: "badges", href: "/admin/badges", icon: Award }
        ]
    },
    {
        key: "communication",
        sections: [
            { key: "email", href: "/admin/email", icon: Mail },
            { key: "channels", href: "/admin/email/channels", icon: Radio },
            { key: "announcements", href: "/admin/announcements", icon: Megaphone },
            { key: "safety", href: "/admin/safety", icon: Flag },
            { key: "chat", href: "/admin/apps/chat/settings", icon: MessageSquare }
        ]
    },
    {
        key: "platform",
        sections: [
            { key: "updates", href: "/admin/updates", icon: RefreshCw },
            { key: "settings", href: "/admin/settings", icon: Settings },
            { key: "apps", href: "/admin/apps", icon: Store },
            { key: "display", href: "/admin/display", icon: SlidersHorizontal },
            { key: "seasonalThemes", href: "/admin/seasonal-themes", icon: PartyPopper },
            { key: "domains", href: "/admin/domains", icon: Globe }
        ]
    },
    {
        key: "integrations",
        sections: [
            { key: "integrations", href: "/admin/integrations", icon: Blocks },
            { key: "integrationsModels", href: "/admin/integrations/models", icon: Sparkles },
            { key: "agents", href: "/admin/agents", icon: Bot }
        ]
    },
    {
        key: "storage",
        sections: [
            { key: "storage", href: "/admin/storage", icon: HardDrive },
            { key: "uploads", href: "/admin/uploads", icon: HardDrive },
            { key: "retention", href: "/admin/retention", icon: Trash2 }
        ]
    },
    {
        key: "usage",
        sections: [
            { key: "consumption", href: "/admin/consumption", icon: Gauge },
            { key: "billing", href: "/admin/billing", icon: Wallet },
            { key: "diagnostics", href: "/admin/diagnostics", icon: Stethoscope }
        ]
    }
] as const;

export default async function ManagementPage() {
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        <>
            <PageHeader title={t("overview.title")} description={t("overview.description")} />
            <div className="flex flex-col gap-8">
                {GROUPS.map((group) => (
                    <section
                        key={group.key}
                        aria-labelledby={`overview-${group.key}`}
                        className="flex flex-col gap-3"
                    >
                        <h2
                            id={`overview-${group.key}`}
                            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                        >
                            {t(`overview.groups.${group.key}`)}
                        </h2>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {group.sections.map((section) => {
                                const Icon = section.icon;
                                return (
                                    <Link
                                        key={section.href}
                                        href={section.href}
                                        className="group flex items-start gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary hover:bg-primary/5"
                                    >
                                        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary">
                                            <Icon className="size-5" />
                                        </span>
                                        <span className="flex min-w-0 flex-col">
                                            <span className="flex items-center gap-1 text-sm font-medium">
                                                {t(`overview.sections.${section.key}.title`)}
                                                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                                            </span>
                                            <span className="text-xs text-muted-foreground">
                                                {t(`overview.sections.${section.key}.description`)}
                                            </span>
                                        </span>
                                    </Link>
                                );
                            })}
                        </div>
                    </section>
                ))}
            </div>
        </>
    );
}
