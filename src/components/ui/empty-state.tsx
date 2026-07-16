import * as React from "react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
}

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-graphite-200 bg-graphite-50/50 px-6 py-12 text-center animate-fade-in",
        className
      )}
      {...props}
    >
      {Icon && (
        <div className="relative">
          {/* Soft ambient glow so the empty state reads as a lit focal point,
              not a flat placeholder. Purely decorative. */}
          <div aria-hidden="true" className="absolute inset-0 -z-10 scale-[1.8] rounded-full bg-horizon-200/40 blur-2xl" />
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-horizon-50 text-horizon-600 ring-1 ring-horizon-100">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </div>
        </div>
      )}
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {description && (
          <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export { EmptyState }
