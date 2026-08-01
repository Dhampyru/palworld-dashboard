'use client'

import { useState, type ReactNode } from 'react'
import { useServer } from '@/lib/server-context'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import type { Player } from '@/lib/types'

// Shared player kick/ban/unban actions + confirmation dialog. Extracted from
// PlayerRoster (2026-07-10) so the live chat feed can action players the exact
// same way. Returns the handlers plus a ready-to-render confirmation dialog;
// callers wire kick/ban to setConfirmAction and render {confirmDialog}.
export function usePlayerActions(onAfterAction?: () => void) {
  const { apiCall, addBannedPlayer, removeBannedPlayer } = useServer()
  const [confirmAction, setConfirmAction] = useState<{ type: 'kick' | 'ban'; player: Player } | null>(null)

  const handleKick = async (player: Player) => {
    if (!player.userId) {
      toast.error(`Cannot kick ${player.name}: missing user ID`)
      setConfirmAction(null)
      return
    }
    try {
      await apiCall('kick', 'POST', { userid: player.userId })
      toast.success(`Kicked ${player.name}`)
      onAfterAction?.()
    } catch {
      toast.error(`Failed to kick ${player.name}`)
    }
    setConfirmAction(null)
  }

  const handleBan = async (player: Player) => {
    if (!player.userId) {
      toast.error(`Cannot ban ${player.name}: missing user ID`)
      setConfirmAction(null)
      return
    }
    try {
      await apiCall('ban', 'POST', { userid: player.userId })
      addBannedPlayer({ name: player.name, steamId: player.userId, bannedAt: new Date().toISOString() })
      toast.success(`Banned ${player.name}`)
      onAfterAction?.()
    } catch {
      toast.error(`Failed to ban ${player.name}`)
    }
    setConfirmAction(null)
  }

  const handleUnban = async (player: Player) => {
    if (!player.userId) {
      toast.error(`Cannot unban ${player.name}: missing user ID`)
      return
    }
    try {
      await apiCall('unban', 'POST', { userid: player.userId })
      removeBannedPlayer(player.userId)
      toast.success(`Unbanned ${player.name}`)
    } catch {
      toast.error(`Failed to unban ${player.name}`)
    }
  }

  const confirmDialog: ReactNode = (
    <AlertDialog open={!!confirmAction} onOpenChange={() => setConfirmAction(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmAction?.type === 'kick' ? 'Kick Player' : 'Ban Player'}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to {confirmAction?.type} {confirmAction?.player.name}?
            {confirmAction?.type === 'ban' && ' This action can be reversed by unbanning the player.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (confirmAction?.type === 'kick') handleKick(confirmAction.player)
              else if (confirmAction?.type === 'ban') handleBan(confirmAction.player)
            }}
            className={confirmAction?.type === 'ban' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
          >
            {confirmAction?.type === 'kick' ? 'Kick' : 'Ban'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { confirmAction, setConfirmAction, handleKick, handleBan, handleUnban, confirmDialog }
}
