/**
 * Design system của giao diện mới (Phase 1: nền tảng — xem design/prototype). Chỉ được nạp lười
 * (Design kit, shell mới sau cờ "New interface") → không làm lớn bundle khởi động của giao diện hiện
 * tại. Token: ./tokens.css (đã nhập trong styles.css).
 */
export { DsProvider, useDensity, type Density } from './provider'
export { Button, IconButton, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button'
export { Input, SearchInput, Field, type InputProps } from './Input'
export { Select, Combobox, type SelectOption } from './Select'
export { Checkbox, Switch, type CheckedState } from './Checkbox'
export { SegmentedControl, type SegmentedOption } from './Segmented'
export { Tabs, TabPanel, type TabItem } from './Tabs'
export { Tooltip } from './Tooltip'
export { Popover } from './Popover'
export { Menu, ContextMenu, type MenuEntry } from './Menu'
export { Dialog, ConfirmDialog } from './Dialog'
export { type ConfirmRisk } from './confirm-logic'
export {
  Toast,
  ToastViewport,
  PropertyList,
  EmptyState,
  Skeleton,
  SkeletonRows,
  type ToastTone,
  type Property
} from './Feedback'
export {
  StatusDot,
  StatusText,
  StatusChip,
  ProblemChip,
  Badge,
  EnvLabel,
  ProdLine,
  Meter,
  envName,
  type StatusTone,
  type BadgeTone,
  type Environment
} from './Status'
export { Kbd } from './Kbd'
export { Inspector, Breadcrumb, INSPECTOR_WIDTH, type Crumb } from './Layout'
export { DataTable, type Column } from './table/DataTable'
export { cx, ICON, ICON_SM } from './utils'
