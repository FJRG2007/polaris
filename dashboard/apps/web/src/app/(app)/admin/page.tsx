import Link from "next/link";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import {
    Activity,
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
    MessagesSquare,
    Scale,
    Settings,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
    Users,
    UsersRound,
    Wallet
} from "lucide-react";

/**
 * The Management app's home: one card per administration area. The areas
 * themselves are the existing admin pages; this page (and the app's sidebar)
 * gather them into a single place instead of the account menu. Each card's
 * words are `overview.sections.<key>` in the `admin` catalog.
 */
const SECTIONS = [
    { key: "users", href: "/admin/users", icon: Users },
    { key: "groups", href: "/admin/groups", icon: UsersRound },
    { key: "roles", href: "/admin/roles", icon: IdCard },
    { key: "policies", href: "/admin/policies", icon: Scale },
    { key: "security", href: "/admin/security", icon: ShieldCheck },
    { key: "activity", href: "/admin/activity", icon: Activity },
    { key: "evidence", href: "/admin/evidence", icon: ClipboardCheck },
    { key: "inbox", href: "/admin/inbox", icon: MessagesSquare },
    { key: "chat", href: "/admin/chat", icon: MessageSquare },
    { key: "email", href: "/admin/email", icon: Mail },
    { key: "domains", href: "/admin/domains", icon: Globe },
    { key: "consumption", href: "/admin/consumption", icon: Gauge },
    { key: "billing", href: "/admin/billing", icon: Wallet },
    { key: "organizations", href: "/admin/organizations", icon: Building2 },
    { key: "display", href: "/admin/display", icon: SlidersHorizontal },
    { key: "agents", href: "/admin/agents", icon: Bot },
    { key: "uploads", href: "/admin/uploads", icon: HardDrive },
    { key: "integrations", href: "/admin/integrations", icon: Blocks },
    { key: "integrationsModels", href: "/admin/integrations/models", icon: Sparkles },
    { key: "settings", href: "/admin/settings", icon: Settings }
] as const;

export default async function ManagementPage() {
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        <>
            <PageHeader
                title={t("overview.title")}
                description={t("overview.description")}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {SECTIONS.map((section) => {
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
                                    <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {t(`overview.sections.${section.key}.description`)}
                                </span>
                            </span>
                        </Link>
                    );
                })}
            </div>
        </>
    );
}
