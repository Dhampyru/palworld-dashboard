'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { copyToClipboard } from '@/lib/clipboard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import { CheckIcon, CopyIcon, DownloadIcon, Link2Icon, PackageIcon, RefreshCwIcon, Trash2Icon, UsersIcon } from 'lucide-react'

type ShareInfo = {
  token: string
  fileName: string
  sizeBytes: number
  createdAt: number
  label: string | null
  serverName: string | null
  gameVersion: string | null
  connect: string | null
  summary: { lua: number; pak: number; logic: number; parity: number; skipped: number; ue4ss: boolean }
  expiresAt: number | null
  maxUses: number | null
  uses: number
  requiresPass: boolean
}

// PATCH (not upstream): client mod-sync, Phase 1 (docs/specs/client-mod-sync.md).
// A read-only "invite / server requirements" surface: shows what a joining client
// needs and generates a copy-paste onboarding packet the admin shares with friends.
// No client automation yet (that's Phase 2). The connect address is admin-entered
// — the server doesn't know its own public IP (PublicIP is blank).

type Manifest = {
  serverName: string | null
  gameVersion: string | null
  port: number
  ue4ss: { source: string | null; sha: string | null; version: string | null }
  palschema: { installed: boolean; version: string | null }
  clientMods: { file: string; sizeBytes: number; sha256: string }[]
  generatedAt: string
}

const HOST_KEY = 'inviteConnectHost'

export function InvitePanel() {
  const { config } = useServer()
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [loading, setLoading] = useState(false)
  const [host, setHost] = useState('')
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Client-mod loadout builder (moved here from the Client-mods tab — this is the
  // onboarding/align-friends area). keptCount is fetched for the button label/gate.
  const [keptCount, setKeptCount] = useState<number | null>(null)
  const [includeUe4ss, setIncludeUe4ss] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [lastLoadout, setLastLoadout] = useState<string | null>(null)

  // Friend share links.
  const [shares, setShares] = useState<ShareInfo[]>([])
  const [shareLabel, setShareLabel] = useState('')
  const [shareExpiry, setShareExpiry] = useState('0') // hours; '0' = never
  const [shareMaxUses, setShareMaxUses] = useState('') // '' = unlimited
  const [sharePass, setSharePass] = useState('')
  const [creatingShare, setCreatingShare] = useState(false)
  const [copiedToken, setCopiedToken] = useState<string | null>(null)

  useEffect(() => {
    try {
      const s = localStorage.getItem(HOST_KEY)
      if (s) setHost(s)
    } catch {
      /* ignore */
    }
  }, [])

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    try {
      const res = await fetch('/api/manifest', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      setManifest(json as Manifest)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load manifest')
    } finally {
      setLoading(false)
    }
    // How many client mods are kept (for the loadout button label + gate). Best-effort.
    try {
      const cm = await fetch('/api/client-mods', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      if (cm.ok) {
        const j = await cm.json()
        setKeptCount((j.mods ?? []).filter((m: { keep?: boolean }) => m.keep).length)
      }
    } catch {
      /* ignore */
    }
    // Existing share links.
    try {
      const sh = await fetch('/api/client-mods/share', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      if (sh.ok) setShares((await sh.json()).shares ?? [])
    } catch {
      /* ignore */
    }
  }, [config])

  useEffect(() => {
    void load()
  }, [load])

  const onHostChange = (v: string) => {
    setHost(v)
    try {
      localStorage.setItem(HOST_KEY, v)
    } catch {
      /* ignore */
    }
  }

  const generateLoadout = useCallback(async () => {
    if (!config) return
    setGenerating(true)
    setLastLoadout(null)
    try {
      // Generate the bundle server-side → one-time download token → stream to disk.
      const res = await fetch(`/api/client-mods/loadout?ue4ss=${includeUe4ss ? '1' : '0'}`, {
        method: 'POST',
        headers: buildPalworldProxyHeaders(config),
        cache: 'no-store',
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      const s = json.summary ?? {}
      const sizeMb = (Number(s.sizeBytes ?? 0) / 1024 / 1024).toFixed(0)
      const summary = `${s.luaMods?.length ?? '?'} Lua + ${s.pakFiles?.length ?? '?'} pak${s.palSchemaMods ? ` + ${s.palSchemaMods} PalSchema` : ''} · ${sizeMb} MB · UE4SS ${s.includedUe4ss ? 'included' : 'excluded'}${s.configOverrides ? ` · ${s.configOverrides} config` : ''}${s.engineTweaks?.length ? ` · ${s.engineTweaks.length} Engine.ini tweak(s)` : ''}${s.reshade?.files ? ` · ReShade (${s.reshade.files} files${s.reshade.presets?.length ? `, ${s.reshade.presets.length} preset` : ''})` : ''}${s.skipped?.length ? ` · ${s.skipped.length} skipped (see manifest.json)` : ''}`
      setLastLoadout(summary)
      const a = document.createElement('a')
      a.href = `/api/client-mods/loadout?token=${encodeURIComponent(json.token)}`
      a.download = json.fileName ?? 'palworld-client-loadout.zip'
      document.body.appendChild(a)
      a.click()
      a.remove()
      toast.success(`Loadout built — ${summary}. Download starting…`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Loadout generation failed')
    } finally {
      setGenerating(false)
    }
  }, [config, includeUe4ss])

  const shareUrl = useCallback((token: string) => {
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    return `${origin}/share/${token}`
  }, [])

  const inviteText = useMemo(() => {
    if (!manifest) return ''
    const name = manifest.serverName ?? 'the server'
    const connect = host.trim() ? `${host.trim()}:${manifest.port}` : `<your public IP>:${manifest.port}`
    // Newest still-valid share link (not expired, uses left), if any — so the invite carries a
    // direct download instead of "ask me for the bundle".
    const now = Date.now()
    const validShare = shares
      .filter((s) => (s.expiresAt == null || s.expiresAt > now) && (s.maxUses == null || s.uses < s.maxUses))
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    const lines: string[] = []
    lines.push(`Join ${name}!`)
    lines.push('')
    lines.push(`Connect address: ${connect}`)
    if (manifest.gameVersion) {
      lines.push(`Palworld version: ${manifest.gameVersion} — update via Steam if yours differs (you can't join otherwise).`)
    }
    lines.push('')
    if (validShare) {
      lines.push(`Mods: download the bundle here — ${shareUrl(validShare.token)}`)
      if (validShare.requiresPass) lines.push('(It’ll ask for a passphrase — I’ll send that separately.)')
      lines.push('Close Palworld, extract the .zip into your Palworld install folder')
      lines.push('(…\\Steam\\steamapps\\common\\Palworld\\), merging when asked, then relaunch.')
      lines.push('That’s everything you need to match the server.')
    } else {
      lines.push('Mods: ask me for the mod bundle (a single .zip). Close Palworld, extract it')
      lines.push('into your Palworld install folder (…\\Steam\\steamapps\\common\\Palworld\\),')
      lines.push('merging when asked, then relaunch. That’s everything you need to match the server.')
    }
    return lines.join('\n')
  }, [manifest, host, shares, shareUrl])

  const createShare = useCallback(async () => {
    if (!config) return
    setCreatingShare(true)
    try {
      const res = await fetch('/api/client-mods/share', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          includeUe4ss,
          serverName: manifest?.serverName ?? null,
          gameVersion: manifest?.gameVersion ?? null,
          port: manifest?.port,
          connectHost: host.trim() || null,
          label: shareLabel.trim() || null,
          expiryHours: Number(shareExpiry) || null,
          maxUses: Number(shareMaxUses) || null,
          passphrase: sharePass.trim() || null,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      const share: ShareInfo = json.share
      setShares((prev) => [share, ...prev])
      setShareLabel('')
      setSharePass('')
      const ok = await copyToClipboard(shareUrl(share.token), { silent: true })
      toast.success(ok ? 'Share link created & copied — send it to your friend' : 'Share link created — copy it from the list')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create share link')
    } finally {
      setCreatingShare(false)
    }
  }, [config, includeUe4ss, manifest, host, shareLabel, shareExpiry, shareMaxUses, sharePass, shareUrl])

  const revokeAllShares = useCallback(async () => {
    if (!config) return
    if (!window.confirm('Revoke ALL share links? Every link stops working immediately.')) return
    try {
      const res = await fetch('/api/client-mods/share?all=1', { method: 'DELETE', headers: buildPalworldProxyHeaders(config) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText)
      setShares([])
      toast.success('All links revoked')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Revoke failed')
    }
  }, [config])

  const revokeShare = useCallback(
    async (token: string) => {
      if (!config) return
      if (!window.confirm('Revoke this link? Anyone with it will no longer be able to download.')) return
      try {
        const res = await fetch(`/api/client-mods/share?token=${encodeURIComponent(token)}`, {
          method: 'DELETE',
          headers: buildPalworldProxyHeaders(config),
        })
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText)
        setShares((prev) => prev.filter((s) => s.token !== token))
        toast.success('Link revoked')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Revoke failed')
      }
    },
    [config],
  )

  const copyShareLink = useCallback(
    async (token: string) => {
      const ok = await copyToClipboard(shareUrl(token), { silent: true })
      if (ok) {
        setCopiedToken(token)
        setTimeout(() => setCopiedToken((t) => (t === token ? null : t)), 2000)
        toast.success('Link copied')
      } else {
        toast.error('Copy failed — select the link and copy manually')
      }
    },
    [shareUrl],
  )

  const copyInvite = useCallback(async () => {
    const ok = await copyToClipboard(inviteText, { silent: true })
    if (ok) {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 2000)
      toast.success('Invite copied to clipboard')
    } else {
      toast.error('Could not copy — select the text and copy manually')
    }
  }, [inviteText])

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UsersIcon className="size-5" />
          <h2 className="text-lg font-semibold">Invite &amp; Align Friends</h2>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm hover:bg-muted disabled:opacity-50"
        >
          <RefreshCwIcon className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          Refresh
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        What a friend needs to join this modded server: the game (matching version) and the mod bundle you
        generate below — one <span className="font-medium">.zip</span> with everything (client mods + the
        server&apos;s paks + UE4SS + config).
      </p>

      {!manifest ? (
        <p className="text-sm text-muted-foreground">
          {loading ? 'Loading server requirements…' : 'No manifest loaded.'}
        </p>
      ) : (
        <>
          {/* Server + versions */}
          <div className="grid gap-2 rounded-md border p-3 text-sm sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">Server:</span>{' '}
              <span className="font-medium">{manifest.serverName ?? 'unknown'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Game version:</span>{' '}
              <span className="font-mono">{manifest.gameVersion ?? 'unknown'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">UE4SS:</span>{' '}
              <span className="font-mono text-xs">
                {manifest.ue4ss.version ?? '—'}
                {manifest.ue4ss.sha ? ` #${manifest.ue4ss.sha}` : ''}
              </span>{' '}
              <span className="text-xs text-muted-foreground">(server-side)</span>
            </div>
            <div>
              <span className="text-muted-foreground">PalSchema:</span>{' '}
              <span className="font-mono text-xs">
                {manifest.palschema.installed ? (manifest.palschema.version ?? 'installed') : 'not installed'}
              </span>{' '}
              <span className="text-xs text-muted-foreground">(server-side)</span>
            </div>
          </div>

          {/* Connect address (admin-entered — the server doesn't know its public IP) */}
          <div className="flex flex-col gap-1.5 rounded-md border p-3">
            <label className="text-sm font-medium">Connect address</label>
            <div className="flex items-center gap-2">
              <Input
                placeholder="your public IP or domain"
                value={host}
                onChange={(e) => onHostChange(e.target.value)}
                className="max-w-xs"
              />
              <span className="font-mono text-sm text-muted-foreground">:{manifest.port}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              The dashboard can&apos;t detect your public IP — enter what friends use to connect. Saved locally.
            </p>
          </div>

          {/* Shareable invite packet */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Shareable invite</span>
              <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={copyInvite}>
                {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                {copied ? 'Copied' : 'Copy invite text'}
              </Button>
            </div>
            <textarea
              readOnly
              value={inviteText}
              rows={Math.min(14, inviteText.split('\n').length + 1)}
              className="w-full resize-y rounded-md border bg-muted/20 p-3 font-mono text-xs"
            />
          </div>
        </>
      )}

      {/* Build friend loadout — the onboarding payoff (moved here from the Client-mods tab) */}
      <div className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 p-3">
        <div className="flex items-center gap-2">
          <PackageIcon className="size-4 text-primary" />
          <span className="text-sm font-semibold">Build friend loadout</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Packages your kept client mods
          {keptCount != null ? (
            <>
              {' '}(<span className="font-medium text-foreground">{keptCount}</span>)
            </>
          ) : (
            ''
          )}{' '}
          into a Classic-UE4SS bundle your friend extracts over their Palworld install — no Steam Workshop or Nexus
          needed on their end. Includes an <span className="font-mono">INSTALL.txt</span> +{' '}
          <span className="font-mono">install.ps1</span>. Stage which mods to include under{' '}
          <span className="font-medium text-foreground">Mods → Client mods</span>.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            className="h-9 gap-1.5 text-xs"
            onClick={generateLoadout}
            disabled={generating || keptCount === 0}
          >
            {generating ? <Spinner className="size-3.5" /> : <DownloadIcon className="size-3.5" />}
            {generating ? 'Building…' : 'Generate & download'}
          </Button>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeUe4ss}
              onChange={(e) => setIncludeUe4ss(e.target.checked)}
              className="size-4 accent-primary"
            />
            Include UE4SS loader (self-contained)
          </label>
        </div>
        {generating && (
          <p className="text-[11px] text-muted-foreground">
            Assembling on the server — a large set can take a minute and download as a big .zip.
          </p>
        )}
        {lastLoadout && <p className="text-[11px] text-emerald-600 dark:text-emerald-400">Last build: {lastLoadout}</p>}
      </div>

      {/* Share links — a friend-facing web download (no admin login for them) */}
      <div className="flex flex-col gap-2 rounded-md border p-3">
        <div className="flex items-center gap-2">
          <Link2Icon className="size-4 text-primary" />
          <span className="text-sm font-semibold">Share links</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Instead of sending the .zip yourself, create a link a friend can open (no login) to see the server info and
          download the bundle. Snapshots the current mods + connect address; revoke it anytime. Needs your dashboard
          reachable by them (public URL / LAN).
        </p>
        <div className="flex flex-col gap-2">
          <Input
            placeholder="Label (optional, e.g. “for Discord”)"
            value={shareLabel}
            onChange={(e) => setShareLabel(e.target.value)}
            className="sm:max-w-xs"
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <label className="flex items-center gap-1.5">
              Expires
              <select
                value={shareExpiry}
                onChange={(e) => setShareExpiry(e.target.value)}
                className="rounded-md border bg-background px-2 py-1 text-xs"
              >
                <option value="0">Never</option>
                <option value="24">1 day</option>
                <option value="168">7 days</option>
                <option value="720">30 days</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              Max downloads
              <Input
                type="number"
                min={1}
                placeholder="∞"
                value={shareMaxUses}
                onChange={(e) => setShareMaxUses(e.target.value)}
                className="h-8 w-20 text-xs"
              />
            </label>
            <label className="flex items-center gap-1.5">
              Passphrase
              <Input
                placeholder="optional"
                value={sharePass}
                onChange={(e) => setSharePass(e.target.value)}
                className="h-8 w-32 text-xs"
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" className="h-9 gap-1.5 text-xs" onClick={createShare} disabled={creatingShare || keptCount === 0}>
              {creatingShare ? <Spinner className="size-3.5" /> : <Link2Icon className="size-3.5" />}
              {creatingShare ? 'Building…' : 'Create share link'}
            </Button>
            {shares.length > 0 && (
              <button onClick={revokeAllShares} className="text-xs text-muted-foreground hover:text-destructive">
                Revoke all
              </button>
            )}
          </div>
        </div>
        {creatingShare && (
          <p className="text-[11px] text-muted-foreground">Building the bundle for the link — a large set takes a minute.</p>
        )}
        {shares.length > 0 && (
          <ul className="flex flex-col divide-y rounded-md border">
            {shares.map((s) => {
              const expLeft = s.expiresAt ? s.expiresAt - Date.now() : null
              const expired = expLeft != null && expLeft <= 0
              const exhausted = s.maxUses != null && s.uses >= s.maxUses
              return (
              <li key={s.token} className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{s.label ?? 'Share link'}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{shareUrl(s.token)}</div>
                  <div className="flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                    {s.requiresPass && <span title="Passphrase-protected">🔒 passphrase</span>}
                    {s.maxUses != null && (
                      <span className={exhausted ? 'text-amber-500' : ''}>{s.uses}/{s.maxUses} downloads</span>
                    )}
                    {s.expiresAt && (
                      <span className={expired ? 'text-amber-500' : ''}>
                        {expired ? 'expired' : `expires ${new Date(s.expiresAt).toLocaleDateString()}`}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => copyShareLink(s.token)}
                    title="Copy link"
                    className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-primary/10 hover:text-primary"
                  >
                    {copiedToken === s.token ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                    Copy
                  </button>
                  <button
                    onClick={() => revokeShare(s.token)}
                    title="Revoke link"
                    className="inline-flex items-center rounded-md border px-2 py-1 text-xs text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                </div>
              </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
