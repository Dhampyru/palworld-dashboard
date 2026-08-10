'use client'

import type { ReactNode } from 'react'
import { ServerProvider } from '@/lib/server-context'
import { ThemeProvider } from '@/lib/theme-context'
import { VersionWatcher } from '@/components/version-watcher'

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ServerProvider>
        {children}
        <VersionWatcher />
      </ServerProvider>
    </ThemeProvider>
  )
}
