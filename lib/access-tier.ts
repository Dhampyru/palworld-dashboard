// Panel access-tier classification. Delegates to the file-backed credential
// store (panel-auth-store): an entered password resolves to the admin tier, the
// mod tier, or neither. Panel credentials are managed at runtime via the panel
// settings UI, not env vars.
import { verifyTier } from '@/lib/panel-auth-store'
import type { AccessTier } from '@/lib/types'

export type PasswordClass = 'admin' | 'mod' | 'unknown'

export function classifyPassword(password: string): PasswordClass {
  const tier = verifyTier(password)
  return tier === 'admin' ? 'admin' : tier === 'mod' ? 'mod' : 'unknown'
}

export function tierForClass(passwordClass: PasswordClass): AccessTier | 'invalid' {
  switch (passwordClass) {
    case 'admin':
      return 'admin'
    case 'mod':
      return 'mod'
    default:
      return 'invalid'
  }
}
