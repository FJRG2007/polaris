/**
 * @polaris/ui - the dashboard design system. Import primitives, the shell, and
 * the capability context from here. The Tailwind preset and token stylesheet are
 * exported as separate entry points (./preset and ./styles.css) so apps wire
 * them into their own Tailwind and global CSS.
 */

export { cn } from "./lib/cn.js";
export { Button, buttonVariants, type ButtonProps } from "./components/button.js";
export { Input, type InputProps } from "./components/input.js";
export { Badge, type BadgeProps } from "./components/badge.js";
export { Card, CardHeader, CardTitle, CardBody } from "./components/card.js";
export { Skeleton } from "./components/skeleton.js";
export { Checkbox, type CheckboxProps } from "./components/checkbox.js";
export { Switch } from "./components/switch.js";
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
} from "./components/select.js";
export { RadialGauge, TimeSeriesChart, type GaugeTone, type TimePoint } from "./components/charts.js";
export * from "./components/dropdown-menu.js";
export * from "./components/context-menu.js";
export * from "./components/dialog.js";
export * from "./shell/capabilities.js";
export { AppSwitcher, type PolarisApp } from "./shell/app-switcher.js";
export { AppShell, PolarisMark, PageHeader } from "./shell/app-shell.js";
