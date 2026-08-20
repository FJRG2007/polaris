/**
 * @polaris/ui - the dashboard design system. Import primitives, the shell, and
 * the capability context from here. The Tailwind preset and token stylesheet are
 * exported as separate entry points (./preset and ./styles.css) so apps wire
 * them into their own Tailwind and global CSS.
 */

export { cn } from "./lib/cn";
export { keepFocusOnClose } from "./lib/menu-focus";
export { useDeferredFocus } from "./lib/use-deferred-focus";
export { MenuSearch, menuSearchMatches } from "./components/menu-search";
export { MenuSurfaceProvider, useMenuSurface, type MenuSurfaceState } from "./lib/menu-surface";
export { Button, buttonVariants, type ButtonProps } from "./components/button";
export { Input, type InputProps } from "./components/input";
export { Textarea, type TextareaProps } from "./components/textarea";
export { Badge, type BadgeProps } from "./components/badge";
export { Card, CardHeader, CardTitle, CardBody } from "./components/card";
export { Skeleton } from "./components/skeleton";
export { EmptyState } from "./components/empty-state";
export { BoneSkeleton, type CapturedLayout, type ResponsiveLayout } from "./components/bone-skeleton";
export { Checkbox, type CheckboxProps } from "./components/checkbox";
export { ConfirmDeleteDialog, type ConfirmDeleteDialogProps } from "./components/confirm-delete-dialog";
export { Switch } from "./components/switch";
export { ToastProvider, useToast, type Toast } from "./components/toast";
export {
    Select,
    SelectRoot,
    SelectGroup,
    SelectValue,
    SelectTrigger,
    SelectContent,
    SelectLabel,
    SelectItem,
    SelectSeparator,
    type SelectOption,
    type SelectProps
} from "./components/select";
export { SegmentedControl, type SegmentedOption } from "./components/segmented-control";
export { RadialGauge, TimeSeriesChart, type GaugeTone, type TimePoint } from "./components/charts";
export { summarizeSeries, type SeriesStats, type SeriesSummary } from "./lib/series-summary";
export * from "./components/dropdown-menu";
export * from "./components/context-menu";
export * from "./components/dialog";
export * from "./shell/capabilities";
export { AppSwitcher, type PolarisApp } from "./shell/app-switcher";
export { MobileNav } from "./shell/mobile-nav";
export { AppShell, PolarisMark, PageHeader, PAGE_FILL, PAGE_BLEED } from "./shell/app-shell";
