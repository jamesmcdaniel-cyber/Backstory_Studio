'use client'

import { useState } from 'react'
import { Check, Copy, Link2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Visibility = 'shared' | 'view' | 'private'

const OPTIONS: { value: Visibility; label: string; hint: string }[] = [
  { value: 'shared', label: 'Everyone can edit', hint: 'Anyone in your workspace can jam on and run this flow.' },
  { value: 'view', label: 'Everyone can view, only you edit', hint: 'Your workspace can open and run it; only you make changes.' },
  { value: 'private', label: 'Only you', hint: 'Just you can see this flow.' },
]

/**
 * Jam: share a flow and invite people to it. The invite link points straight at
 * the flow (/flows/<id>); with the login return_to fix, an invitee who signs in
 * lands on this flow rather than the dashboard. Real-time presence/co-editing is
 * layered on top of this (see the collaboration work); this dialog owns invite +
 * access.
 */
export function JamDialog({
  open,
  onOpenChange,
  flowId,
  flowName,
  visibility,
  canEdit,
  onChangeVisibility,
  presence,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  flowId: string
  flowName: string
  visibility: Visibility
  canEdit: boolean
  onChangeVisibility: (next: Visibility) => void
  /** Who else is currently in this flow (names/initials), if presence is live. */
  presence?: { id: string; name: string }[]
}) {
  const [copied, setCopied] = useState(false)
  const inviteLink = typeof window !== 'undefined' ? `${window.location.origin}/flows/${flowId}` : `/flows/${flowId}`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink)
      setCopied(true)
      toast.success('Invite link copied')
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy the link')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-indigo-600" />
            Jam on “{flowName || 'this flow'}”
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Invite link</p>
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm">{inviteLink}</span>
              </div>
              <Button variant="outline" size="sm" onClick={copy}>
                {copied ? <Check className="mr-1.5 h-4 w-4 text-green-600" /> : <Copy className="mr-1.5 h-4 w-4" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Anyone you send this to opens straight into this flow after signing in. They can jam based on the access below.
            </p>
          </div>

          {presence && presence.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Here now</p>
              <div className="flex flex-wrap gap-2">
                {presence.map((p) => (
                  <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 text-xs">
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-indigo-100 text-[9px] font-semibold text-indigo-700">
                      {p.name.trim().charAt(0).toUpperCase() || '?'}
                    </span>
                    {p.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Who can access</p>
            {canEdit ? (
              <div className="space-y-1.5">
                {OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => onChangeVisibility(option.value)}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                      visibility === option.value
                        ? 'border-indigo-300 bg-indigo-50/60 dark:border-indigo-500/40 dark:bg-indigo-500/10'
                        : 'border-border/70 hover:bg-accent',
                    )}
                  >
                    <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', visibility === option.value ? 'border-indigo-500 bg-indigo-500' : 'border-muted-foreground/40')}>
                      {visibility === option.value && <Check className="h-3 w-3 text-white" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className="block text-xs text-muted-foreground">{option.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-border/70 bg-muted/40 p-3 text-sm text-muted-foreground">
                {OPTIONS.find((o) => o.value === visibility)?.hint ?? 'Only the owner can change who can access this flow.'}
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
