/**
 * Drawer — re-export from @kata-sh/ui.
 *
 * The implementation moved to packages/ui so it can be used by shared chat
 * components (e.g. the compact Accept-Plan drawer in TurnCard). Existing
 * `@/components/ui/drawer` imports keep working via this shim.
 */
export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
} from '@kata-sh/ui/ui/drawer'
