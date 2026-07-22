'use client'

import { Check, Sparkles, X } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { KIND_LABEL, ProposalPreview, type ProposalCard } from './proposal-shared'

/**
 * The "little more detail" popup shared by the home Recommendations bar and the
 * notification bell. Dumb component — accept/dismiss are handled by the owner
 * (ProposalsProvider) so every surface stays in sync.
 */
export function ProposalDetailDialog({
  proposal,
  busy,
  onOpenChange,
  onAccept,
  onDismiss,
}: {
  proposal: ProposalCard | null
  busy: boolean
  onOpenChange: (open: boolean) => void
  onAccept: (proposal: ProposalCard) => void
  onDismiss: (proposal: ProposalCard) => void
}) {
  const isImprovement = proposal?.kind === 'process_improvement'
  return (
    <Dialog open={Boolean(proposal)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {proposal && (
          <>
            <DialogHeader>
              <span className="inline-flex w-fit items-center gap-1 rounded-md bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                <Sparkles className="h-3 w-3" /> {KIND_LABEL[proposal.kind] ?? 'Suggestion'}
              </span>
              <DialogTitle className="mt-1.5 text-base">{proposal.title}</DialogTitle>
            </DialogHeader>
            <p className="text-sm leading-6 text-gray-600">{proposal.rationale}</p>
            <ProposalPreview proposal={proposal} clamp={false} />
            <div className="mt-4 flex gap-2">
              <Button
                type="button"
                loading={busy}
                onClick={() => onAccept(proposal)}
                className="flex-1"
              >
                {!busy && <Check className="h-4 w-4" />}
                {isImprovement ? 'Open and improve' : 'Accept'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onDismiss(proposal)}
              >
                <X className="h-4 w-4" /> Dismiss
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
