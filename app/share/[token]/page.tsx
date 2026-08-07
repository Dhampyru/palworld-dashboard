import type { Metadata } from 'next'
import { getShare } from '@/lib/client-shares'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Join the server — mod bundle' }

// PATCH (not upstream): the PUBLIC friend-facing share page (docs/specs/client-mod-sync.md
// §8). A server component — no login gate (that's only in app/page.tsx). Renders the curated
// share info (server identity + connect + one download) for a non-admin friend the admin
// sent a link to. The unguessable token in the URL is the only capability.
function fmtMB(n: number): string {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(0)} MB`
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const share = await getShare(token)

  if (!share) {
    return (
      <main className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
        <h1 className="text-xl font-semibold">Link not found</h1>
        <p className="text-sm text-muted-foreground">
          This mod-bundle link is invalid or has been revoked. Ask whoever sent it for a fresh one.
        </p>
      </main>
    )
  }

  const s = share.summary
  const modCount = s.lua + s.pak + s.logic

  return (
    <main className="mx-auto flex min-h-[85vh] max-w-lg flex-col justify-center gap-5 px-4 py-10">
      <div className="rounded-2xl border border-border/60 bg-card/50 p-6 backdrop-blur-sm sm:p-8">
        <p className="text-xs uppercase tracking-wide text-primary">You&apos;re invited to</p>
        <h1 className="mt-1 text-2xl font-semibold text-balance">{share.serverName ?? 'a modded Palworld server'}</h1>

        <dl className="mt-5 grid gap-2 text-sm">
          {share.connect && (
            <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2">
              <dt className="text-muted-foreground">Connect address</dt>
              <dd className="font-mono">{share.connect}</dd>
            </div>
          )}
          {share.gameVersion && (
            <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2">
              <dt className="text-muted-foreground">Palworld version</dt>
              <dd className="font-mono text-xs">{share.gameVersion}</dd>
            </div>
          )}
        </dl>
        {share.gameVersion && (
          <p className="mt-2 text-xs text-muted-foreground">
            Your Palworld must be this version to join — update via Steam if it differs.
          </p>
        )}

        <a
          href={`/api/share/${token}/download`}
          download
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          ⬇ Download the mod bundle ({fmtMB(share.sizeBytes)})
        </a>
        <p className="mt-1.5 text-center text-xs text-muted-foreground">
          {modCount} mod{modCount === 1 ? '' : 's'}
          {s.ue4ss ? ' · UE4SS included (self-contained)' : ''} · one .zip
        </p>

        <div className="mt-6 rounded-md border border-primary/20 bg-primary/5 p-4 text-sm">
          <p className="mb-2 font-medium">How to install</p>
          <ol className="ml-4 list-decimal space-y-1 text-xs text-muted-foreground">
            <li>Close Palworld.</li>
            <li>Download the bundle above and extract the whole .zip.</li>
            <li>
              Double-click <span className="font-mono text-foreground">install.bat</span> and follow the prompt.
              (Or copy the <span className="font-mono text-foreground">game</span>{' '}folder&apos;s contents into your
              Palworld install folder — see <span className="font-mono text-foreground">INSTALL.txt</span>.)
            </li>
            <li>Launch Palworld and connect. Mods load ~1–2 minutes into the world.</li>
          </ol>
        </div>
      </div>
      <p className="text-center text-xs text-muted-foreground">
        These are the client mods this server runs. Nothing here changes your game other than adding these mod files.
      </p>
    </main>
  )
}
