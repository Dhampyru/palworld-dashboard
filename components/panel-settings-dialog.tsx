'use client'

import { useEffect, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FieldLabel } from '@/components/ui/field'
import { toast } from 'sonner'

const MIN_LEN = 6

export function PanelSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { config, setConfig } = useServer()

  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [modPw, setModPw] = useState('')
  const [modEnabled, setModEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  // Nexus integration (docs/specs/nexus-integration.md). Key is a server-side
  // secret — the status never includes the key itself.
  type NexusStatus = {
    configured: boolean
    valid: boolean
    name: string | null
    isPremium: boolean
    source: 'file' | 'env' | null
    error: string | null
  }
  const [nexusKey, setNexusKey] = useState('')
  const [nexusStatus, setNexusStatus] = useState<NexusStatus | null>(null)
  const [nexusBusy, setNexusBusy] = useState(false)

  useEffect(() => {
    if (!open || !config) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/nexus', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
        if (res.ok && !cancelled) setNexusStatus((await res.json()) as NexusStatus)
      } catch {
        /* leave null */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, config])

  const saveNexus = async () => {
    if (!config || !nexusKey.trim()) return
    setNexusBusy(true)
    try {
      const res = await fetch('/api/nexus', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: nexusKey.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to save key')
      setNexusStatus(json as NexusStatus)
      setNexusKey('')
      toast.success(`Nexus connected: ${json.name}${json.isPremium ? ' (Premium)' : ''}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save key')
    } finally {
      setNexusBusy(false)
    }
  }

  const clearNexus = async () => {
    if (!config) return
    setNexusBusy(true)
    try {
      const res = await fetch('/api/nexus', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      setNexusStatus(json as NexusStatus)
      toast.success('Nexus key cleared')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setNexusBusy(false)
    }
  }

  // Steam account for Workshop downloads (docs/specs/steam-workshop-download.md).
  // Connecting is a one-time interactive shell login (see below); the dashboard reads
  // the cached session — no password ever touches it.
  type SteamStatus = { configured: boolean; connected: boolean; username: string | null; error: string | null }
  const [steamStatus, setSteamStatus] = useState<SteamStatus | null>(null)
  const [steamBusy, setSteamBusy] = useState(false)

  useEffect(() => {
    if (!open || !config) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/steam', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
        if (res.ok && !cancelled) setSteamStatus((await res.json()).status as SteamStatus)
      } catch {
        /* leave null */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, config])

  // Re-read status after the operator runs the one-time shell login.
  const refreshSteam = async () => {
    if (!config) return
    setSteamBusy(true)
    try {
      const res = await fetch('/api/steam', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      setSteamStatus(json.status as SteamStatus)
      toast[json.status?.connected ? 'success' : 'message'](
        json.status?.connected ? `Connected as ${json.status.username}` : 'No Steam session detected yet.',
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSteamBusy(false)
    }
  }

  const disconnectSteam = async () => {
    if (!config) return
    setSteamBusy(true)
    try {
      const res = await fetch('/api/steam', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect' }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      setSteamStatus(json.status as SteamStatus)
      toast.success('Steam account disconnected')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSteamBusy(false)
    }
  }

  const testSteam = async () => {
    if (!config) return
    setSteamBusy(true)
    try {
      const res = await fetch('/api/steam', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test' }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      if (json.connected) toast.success('Steam session is valid.')
      else toast.error('Session expired — re-run the one-time sign-in command below.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSteamBusy(false)
    }
  }

  // Click outside the dialog closes it (AlertDialog blocks outside-close by default).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (contentRef.current && !contentRef.current.contains(e.target as Node)) {
        onOpenChange(false)
      }
    }
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, onOpenChange])

  useEffect(() => {
    if (!open) {
      setCurrentPw('')
      setNewPw('')
      setConfirmPw('')
      setModPw('')
      return
    }
    if (!config) return
    fetch('/api/panel-auth/mod-password', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.modEnabled === 'boolean') setModEnabled(d.modEnabled)
      })
      .catch(() => {})
  }, [open, config])

  const changeAdminPassword = async () => {
    if (newPw.length < MIN_LEN) {
      toast.error(`New password must be at least ${MIN_LEN} characters`)
      return
    }
    if (newPw !== confirmPw) {
      toast.error('New passwords do not match')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/panel-auth/admin-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Failed to change password')
        return
      }
      // Keep the current session alive under the new credential.
      if (config) setConfig({ ...config, adminPassword: newPw })
      toast.success('Admin password changed')
      setCurrentPw('')
      setNewPw('')
      setConfirmPw('')
    } catch {
      toast.error('Failed to change password')
    } finally {
      setBusy(false)
    }
  }

  const submitMod = async (disable: boolean) => {
    if (!config) return
    if (!disable && modPw.length < MIN_LEN) {
      toast.error(`Mod password must be at least ${MIN_LEN} characters`)
      return
    }
    setBusy(true)
    try {
      const headers = new Headers(buildPalworldProxyHeaders(config))
      headers.set('Content-Type', 'application/json')
      const res = await fetch('/api/panel-auth/mod-password', {
        method: 'POST',
        headers,
        body: JSON.stringify({ modPassword: disable ? null : modPw }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Failed to update mod access')
        return
      }
      const wasEnabled = modEnabled
      setModEnabled(!disable)
      setModPw('')
      toast.success(disable ? 'Mod access disabled' : wasEnabled ? 'Mod password updated' : 'Mod access enabled')
    } catch {
      toast.error('Failed to update mod access')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent ref={contentRef} className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-mono uppercase tracking-[0.2em]">Panel Settings</AlertDialogTitle>
          <AlertDialogDescription>
            Manage the panel&apos;s own login credentials. These are separate from the game server.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-5">
          {/* Admin password */}
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground/80">Admin Password</p>
            <div className="space-y-1">
              <FieldLabel htmlFor="panel-cur-pw">Current password</FieldLabel>
              <Input id="panel-cur-pw" type="password" autoComplete="current-password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} />
            </div>
            <div className="space-y-1">
              <FieldLabel htmlFor="panel-new-pw">New password</FieldLabel>
              <Input id="panel-new-pw" type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
            </div>
            <div className="space-y-1">
              <FieldLabel htmlFor="panel-conf-pw">Confirm new password</FieldLabel>
              <Input id="panel-conf-pw" type="password" autoComplete="new-password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
            </div>
            <Button size="sm" onClick={changeAdminPassword} disabled={busy || !currentPw || !newPw} className="w-full">
              Change admin password
            </Button>
          </section>

          <div className="h-px bg-border/60" />

          {/* Mod access */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground/80">Mod Access</p>
              <span className={`font-mono text-[10px] uppercase tracking-[0.16em] ${modEnabled ? 'text-primary' : 'text-muted-foreground'}`}>
                {modEnabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              A second login that can kick/ban players and view the roster, but nothing else.
            </p>
            <div className="space-y-1">
              <FieldLabel htmlFor="panel-mod-pw">{modEnabled ? 'New mod password' : 'Mod password'}</FieldLabel>
              <Input id="panel-mod-pw" type="password" autoComplete="new-password" value={modPw} onChange={(e) => setModPw(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => submitMod(false)} disabled={busy || modPw.length < MIN_LEN} className="flex-1">
                {modEnabled ? 'Update password' : 'Enable mod access'}
              </Button>
              {modEnabled && (
                <Button size="sm" variant="outline" onClick={() => submitMod(true)} disabled={busy} className="flex-1 !border-red-500/60 !text-red-300 hover:!bg-red-500/15">
                  Disable
                </Button>
              )}
            </div>
          </section>

          <div className="h-px bg-border/60" />

          {/* Nexus Mods (docs/specs/nexus-integration.md) */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground/80">Nexus Mods</p>
              <span className={`font-mono text-[10px] uppercase tracking-[0.16em] ${nexusStatus?.valid ? 'text-primary' : 'text-muted-foreground'}`}>
                {!nexusStatus?.configured ? 'Not connected' : nexusStatus.valid ? (nexusStatus.isPremium ? 'Premium' : 'Free') : 'Invalid'}
              </span>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Optional personal Nexus API key. A free key enables mod update-checks and Nexus links; one-click
              download, install &amp; bulk-install additionally need a Nexus Premium account. Without a key, these
              stay disabled and you install mods manually.
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Get your key at{' '}
              <a
                href="https://www.nexusmods.com/users/myaccount?tab=api"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
              >
                nexusmods.com → Account → API keys
              </a>{' '}
              — scroll to <span className="font-medium">Personal API Key</span> and click Generate, then paste it
              below. The key is stored on the server only, never shown in the browser.
            </p>
            {nexusStatus?.configured && nexusStatus.valid && (
              <p className="text-[11px] text-primary">
                Connected as {nexusStatus.name}
                {nexusStatus.isPremium ? ' · Premium (auto-download available)' : ' · Free (guided install)'}
                {nexusStatus.source === 'env' ? ' · set via env' : ''}.
              </p>
            )}
            {nexusStatus?.configured && !nexusStatus.valid && (
              <p className="text-[11px] text-red-400">
                Stored key isn&apos;t valid{nexusStatus.error ? `: ${nexusStatus.error}` : ''}.
              </p>
            )}
            <div className="space-y-1">
              <FieldLabel htmlFor="nexus-key">{nexusStatus?.configured ? 'Replace API key' : 'API key'}</FieldLabel>
              <Input
                id="nexus-key"
                type="password"
                autoComplete="off"
                placeholder="nexusmods.com → account → API keys"
                value={nexusKey}
                onChange={(e) => setNexusKey(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={saveNexus} disabled={nexusBusy || !nexusKey.trim()} className="flex-1">
                Save &amp; validate
              </Button>
              {nexusStatus?.configured && nexusStatus.source === 'file' && (
                <Button size="sm" variant="outline" onClick={clearNexus} disabled={nexusBusy} className="flex-1">
                  Clear
                </Button>
              )}
            </div>
          </section>

          {/* Steam account for Workshop downloads (docs/specs/steam-workshop-download.md) */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground/80">
                Steam account · Workshop
              </p>
              <span
                className={`font-mono text-[10px] uppercase tracking-[0.16em] ${steamStatus?.connected ? 'text-primary' : 'text-muted-foreground'}`}
              >
                {!steamStatus?.configured ? 'Not connected' : steamStatus.connected ? 'Connected' : 'Session expired'}
              </span>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Optional. Lets the dashboard auto-download <span className="font-medium">Steam Workshop</span> mods.
              Anonymous can&apos;t download paid-game Workshop content, so this needs an account that{' '}
              <span className="font-medium">owns Palworld</span> — use a{' '}
              <span className="font-medium">dedicated secondary account</span>, not your main.
            </p>
            {steamStatus?.connected ? (
              <>
                <p className="text-[11px] text-primary">Connected as {steamStatus.username}.</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={testSteam} disabled={steamBusy} className="flex-1">
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={disconnectSteam}
                    disabled={steamBusy}
                    className="flex-1"
                  >
                    Disconnect
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Sign in <span className="font-medium">once</span> from your server shell (single session — no
                  password touches the dashboard). Run this, replacing the username; it&apos;ll prompt for your
                  password + a one-time Steam Guard code:
                </p>
                <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 text-[10px] leading-relaxed">
                  <code>{`docker exec -it -e HOME=/app/data/steam \\
  palworld-server-dashboard \\
  /opt/steamcmd/steamcmd.sh +login YOUR_STEAM_USERNAME +quit`}</code>
                </pre>
                <p className="text-[11px] text-muted-foreground">
                  When it says <span className="font-mono">Waiting for user info…OK</span>, the session is cached.
                  Then click Refresh.
                </p>
                <Button size="sm" onClick={refreshSteam} disabled={steamBusy} className="w-fit">
                  {steamBusy ? 'Checking…' : 'Refresh'}
                </Button>
              </>
            )}
          </section>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Close</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
