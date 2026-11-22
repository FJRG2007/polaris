/**
 * @polaris/ui - the dashboard design system. Import primitives, the shell, and
 * the capability context from here. The Tailwind preset and token stylesheet are
 * exported as separate entry points (./preset and ./styles.css) so apps wire
 * them into their own Tailwind and global CSS.
 */

export { cn } from "./lib/cn";
// Menus, selects and tabs read the reading direction from this, not from
// `<html dir>`: the dashboard wraps every page in it (see I18nProvider).
export { DirectionProvider, useDirection } from "@radix-ui/react-direction";
export { PUBLIC_DOCS, publicDocHref } from "./lib/public-docs";
export { OverlayPortal, useOverlayRoot } from "./lib/overlay-root";
export { applePlatform, formatShortcut } from "./lib/shortcut";
export { KeyNamesProvider, useKeyNames } from "./lib/key-names";
export { keepFocusOnClose } from "./lib/menu-focus";
export { rowClickIntent } from "./lib/row-open";
export { useDeferredFocus } from "./lib/use-deferred-focus";
export { pollWhileVisible } from "./lib/poll-while-visible";
export {
    allChosen,
    pressedSelection,
    useRangeSelection,
    type PressKeys
} from "./lib/range-selection";
export { useRowSelection } from "./lib/row-selection";
export { MenuSearch, menuSearchMatches } from "./components/menu-search";
export { refocusMenuSearch } from "./lib/menu-search-focus";
export { MenuSurfaceProvider, useMenuSurface, type MenuSurfaceState } from "./lib/menu-surface";
// Published beside the other menu helpers rather than kept to the context menu.
// It decides when the browser's own right-click menu is suppressed across the
// whole application, which is exactly the kind of rule worth being able to assert
// on directly - see the test that pins when the watch is and is not live.
export { useReopenElsewhere } from "./lib/menu-reopen";
export {
    MenuExtrasProvider,
    useMenuExtrasSource,
    type MenuExtra,
    type MenuExtrasSource
} from "./lib/menu-extras";
export { moved, useListOrder } from "./lib/list-order";
export { isDirty, sameValue } from "./lib/dirty";
export { Button, buttonVariants, type ButtonProps } from "./components/button";
export { Input, type InputProps } from "./components/input";
export { SizeField, type SizeFieldProps } from "./components/size-field";
export { ListField, type ListFieldProps } from "./components/list-field";
export { Textarea, type TextareaProps } from "./components/textarea";
export { Badge, TagList, statusChipClass, type BadgeProps } from "./components/badge";
export { CopyButton, CopyIcon, useCopied } from "./components/copy-button";
export {
    LanDetails,
    LanDetailsRegion,
    type LanDetailsLabels,
    type LanDetailsValue
} from "./components/lan-details";
export {
    ENGLISH_UI_STRINGS,
    UiStringsProvider,
    useUiStrings,
    type UiStrings
} from "./lib/ui-strings";
export {
    DnsRecordTable,
    type DnsRecordRow,
    type DnsRecordStatus
} from "./components/dns-record-table";
export { Card, CardHeader, CardTitle, CardBody } from "./components/card";
export { Skeleton } from "./components/skeleton";
export { EmptyState } from "./components/empty-state";
export {
    arrangeFindings,
    SEVERITY_ORDER,
    splitPackage,
    VulnerabilityTable,
    type ImageFinding,
    type SortKey,
    type VulnerabilityTableLabels
} from "./components/vulnerability-table";
export { ResizeHandle } from "./components/resize-handle";
export { ScrollRow } from "./components/scroll-row";
export {
    BoneSkeleton,
    type CapturedLayout,
    type ResponsiveLayout
} from "./components/bone-skeleton";
export { Checkbox, type CheckboxProps } from "./components/checkbox";
export {
    DateInput,
    type DateInputChange,
    type DateInputMode,
    type DateInputProps
} from "./components/date-input";
export {
    ConfirmDeleteDialog,
    type ConfirmDeleteDialogProps
} from "./components/confirm-delete-dialog";
export { Switch } from "./components/switch";
export {
    VirtualKeyboard,
    type VirtualKeyboardLabels,
    type VirtualKeyboardProps
} from "./components/virtual-keyboard";
export { KEYBOARD_LAYOUTS, layoutForLanguage, type KeyboardLayoutId } from "./lib/keyboard-layouts";
export {
    Popover,
    PopoverClose,
    PopoverAnchor,
    PopoverContent,
    PopoverTrigger
} from "./components/popover";
export { ColorPicker, SUGGESTED_COLORS } from "./components/color-picker";
export {
    ToastProvider,
    useToast,
    type Toast,
    type ToastAction,
    type ToastChoice,
    type ToastConversation,
    type ToastLine,
    type ToastReply
} from "./components/toast";
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
export {
    SearchableSelect,
    filterSearchableOptions,
    type SearchableSelectOption,
    type SearchableSelectProps
} from "./components/searchable-select";
export {
    LanguageSelect,
    languageName,
    languageListName,
    languageOptions,
    type LanguageChoice,
    type LanguageSelectProps
} from "./components/language-select";
export { LanguageFlag, languageFlagCode } from "./components/language-flag";
export { CountryFlag, flagKey } from "./components/country-flag";
export { PhoneInput, phoneCountryOptions, type PhoneInputProps } from "./components/phone-input";
export {
    AsyncSelect,
    AsyncMultiSelect,
    type AsyncFixedOption,
    type AsyncSelectProps,
    type AsyncMultiSelectProps
} from "./components/async-select";
export {
    useAsyncOptions,
    dropAsyncOptions,
    type AsyncLoad,
    type AsyncPage
} from "./lib/use-async-options";
export { SegmentedControl, type SegmentedOption } from "./components/segmented-control";
export {
    SearchField,
    SortHeader,
    nextSort,
    type SortDirection as TableSortDirection
} from "./components/table-toolbar";
export {
    CatalogList,
    CatalogPicked,
    ChoiceCard,
    foldSearch,
    type CatalogEntry
} from "./components/catalog-list";
export { ControlSlider, type ControlSliderProps } from "./components/control-slider";
export { KEY_SETTLE_MS, useReleasedValue } from "./lib/use-released-value";
export {
    bigStep,
    fractionOf,
    keyedValue,
    snapValue,
    stepPlaces,
    valueAt,
    type ValueRange
} from "./lib/control-values";
export {
    MultiSeriesChart,
    RadialGauge,
    SERIES_COLORS,
    TimeSeriesChart,
    type ChartSeries,
    type GaugeTone,
    type TimePoint
} from "./components/charts";
export {
    summarizeSeries,
    type SeriesStatLabel,
    type SeriesStats,
    type SeriesSummary
} from "./lib/series-summary";
export * from "./components/dropdown-menu";
export * from "./components/context-menu";
export * from "./components/dialog";
export * from "./components/bottom-tabs";
export * from "./shell/capabilities";
export {
    AppSwitcher,
    type AppSwitcherStrings,
    type AppTileAction,
    type PolarisApp
} from "./shell/app-switcher";
export { MobileNav } from "./shell/mobile-nav";
export {
    AppLogo,
    APP_LOGO_IDS,
    appLogoPalette,
    hasAppLogo,
    type AppLogoPalette
} from "./shell/app-logo";
export { ProductMark, type PolarisProduct } from "./shell/product-mark";
export {
    AppShell,
    PolarisMark,
    PolarisStar,
    PageHeader,
    PAGE_FILL,
    PAGE_BLEED,
    PAGE_NOTICES,
    PHONE_TABS_HIDE,
    shellScroller
} from "./shell/app-shell";
export { SWIPE_BACK_EDGE } from "./shell/swipe-back";
export {
    fitBoard,
    useBoardGestures,
    wheelFactor,
    zoomViewAt,
    type BoardBounds,
    type BoardGestures,
    type BoardPoint,
    type BoardView
} from "./lib/board-gestures";
export { StatusIcon } from "./components/status-icon";
export * from "./shortcuts/shortcuts";
export {
    refusalOf,
    useOptimisticToggle,
    useOptimisticValue,
    type OptimisticOptions,
    type OptimisticToggleOptions
} from "./lib/use-optimistic-toggle";
