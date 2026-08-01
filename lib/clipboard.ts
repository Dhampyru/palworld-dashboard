// PATCH (not upstream): clipboard helper that works on INSECURE origins.
//
// This dashboard is served over plain http://<ip> on a real IP, which is not a
// "secure context" -- so navigator.clipboard is undefined and every Copy button
// using it silently did nothing. This tries the modern async Clipboard API when
// it actually exists, and otherwise falls back to the classic hidden-textarea +
// document.execCommand('copy'), which still works over http. Either way it
// shows a brief confirmation toast.
//
// Must be called from within a user-gesture handler (a click): execCommand
// requires it. All our copy buttons already are.

import { toast } from 'sonner'

// Legacy path: select a throwaway off-screen textarea and let the browser copy
// its selection. Works on insecure origins where the async API is absent.
function fallbackCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const textarea = document.createElement('textarea')
  textarea.value = text
  // Keep it out of view and out of the layout, and non-interactive.
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '0'
  textarea.style.width = '1px'
  textarea.style.height = '1px'
  textarea.style.padding = '0'
  textarea.style.border = 'none'
  textarea.style.opacity = '0'

  const selection = document.getSelection()
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  document.body.appendChild(textarea)
  textarea.select()
  textarea.setSelectionRange(0, text.length) // iOS needs the explicit range

  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }

  document.body.removeChild(textarea)
  // Restore whatever the user had selected before we hijacked it.
  if (previousRange && selection) {
    selection.removeAllRanges()
    selection.addRange(previousRange)
  }
  return ok
}

export type CopyOptions = {
  // Shown in the toast: "Copied <label>". Omit for a plain "Copied!".
  label?: string
  // Suppress the toast entirely (caller shows its own confirmation).
  silent?: boolean
}

// Copy `text`, returning whether it succeeded. Modern API when genuinely
// available, hidden-textarea fallback otherwise.
export async function copyToClipboard(text: string, options: CopyOptions = {}): Promise<boolean> {
  const { label, silent } = options
  let ok = false

  // Only trust the async API in a secure context; some browsers expose
  // navigator.clipboard on http but reject writeText, so guard AND try/catch.
  if (
    typeof navigator !== 'undefined' &&
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    navigator.clipboard?.writeText
  ) {
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      ok = false
    }
  }

  if (!ok) ok = fallbackCopy(text)

  if (!silent) {
    if (ok) toast.success(label ? `Copied ${label}` : 'Copied!')
    else toast.error('Copy failed — select the text and copy manually.')
  }
  return ok
}
