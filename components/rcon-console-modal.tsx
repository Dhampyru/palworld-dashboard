'use client'

// PATCH (not upstream): the RCON console now lives in a MODAL, not its own tab
// (roadmap #3). It is opened from the header's Console button and from roster
// quick-actions (a `consoleRequest` in server-context). The panel is unchanged
// and still consumes `consoleRequest` on mount, so a quick-action that opens the
// modal prefills the right command exactly as it did when the console was a tab.
//
// A wide right-side Sheet is the modal container: full-width on mobile (the
// single-column console flow), roomy enough on desktop for the command list +
// form two-pane grid. The panel carries its own "RCON Console" header, so the
// Sheet only needs an sr-only title for accessibility.

import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { RconConsolePanel } from '@/components/rcon-console-panel'

export function RconConsoleModal({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl lg:max-w-5xl"
      >
        <SheetTitle className="sr-only">RCON Console</SheetTitle>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <RconConsolePanel />
        </div>
      </SheetContent>
    </Sheet>
  )
}
