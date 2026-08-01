// PATCH (not upstream): Next.js instrumentation hook. register() runs once when
// the server process boots (standalone included). Used to start the in-process
// auto-backup scheduler (lib/backup-schedule). Node runtime only -- it touches
// the filesystem and shells out to tar/rcon, which the edge runtime can't do.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startBackupScheduler } = await import('@/lib/backup-schedule')
    startBackupScheduler()
    const { startAutoRestartMonitor } = await import('@/lib/auto-restart')
    startAutoRestartMonitor()
  }
}
