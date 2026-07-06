# UI Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Component-level UI elevation — motion vocabulary, depth recipes, upgraded + new primitives, applied in place across every screen with layouts frozen.

**Architecture:** Three layers, bottom-up. Layer 1 adds a motion/depth vocabulary to `tailwind.config.js` + CSS. Layer 2 upgrades the 12 existing `src/components/ui/` primitives and adds 8 new ones. Layer 3 applies them screen-by-screen without moving anything.

**Tech Stack:** Next.js 15 (App Router), React 18, Tailwind 3.4, Radix UI, CVA + `cn()` (from `@/lib/utils`), lucide-react, sonner. New: `motion`, `cmdk`, `tailwindcss-animate` (dev), `@radix-ui/react-tooltip`, `@radix-ui/react-dropdown-menu`.

## Global Constraints

- **Layout freeze:** no page layout, grouping, or IA changes anywhere. Component swaps happen in the exact position of what they replace.
- **Brand only:** all values compose existing tokens from `src/app/backstory-design.css` / `tailwind.config.js`. Never revert the intentional `gray|slate|zinc|neutral → graphite` and `blue|indigo|sky → horizon` remaps.
- **Voice:** sentence case, calm and declarative, no emoji — in every string this plan introduces.
- **Motion:** every animation must degrade under `prefers-reduced-motion` (CSS guard in Task 1; `MotionConfig reducedMotion="user"` in Task 6).
- **Allowed new deps (exact list):** `motion`, `cmdk`, `tailwindcss-animate` (devDependency), `@radix-ui/react-tooltip`, `@radix-ui/react-dropdown-menu`. Nothing else.
- **No React component test infra exists** (`npm test` runs `tsx --test` over `src/**/__tests__` lib tests only). Adding one is out of scope (YAGNI). Per-task verification is `npm run typecheck && npm run lint`; `npm run build` at the milestones marked below; visual verification in the dev server for each screen task.
- Commit after every task. Branch: `ui-modernization` (already created).

---

### Task 1: Foundation — motion vocabulary, depth recipes, page background

**Files:**
- Modify: `tailwind.config.js`
- Modify: `src/app/globals.css`
- Modify: `package.json` (via npm install)

**Interfaces:**
- Produces (used by every later task): Tailwind utilities `duration-fast|base|slow`, `ease-out-quart`, `ease-spring`, `animate-fade-in`, `animate-fade-in-up`, `animate-scale-in`, `animate-slide-in-right`, `animate-shimmer`; CSS class `stagger-children`; `tailwindcss-animate` utilities (`animate-in`, `fade-in-0`, `zoom-in-95`, …) that `dialog.tsx`/`select.tsx` already reference.

- [ ] **Step 1: Install tailwindcss-animate**

```bash
npm install -D tailwindcss-animate
```

- [ ] **Step 2: Extend tailwind.config.js**

In the `theme.extend` object, add after `fontFamily`:

```js
      transitionDuration: {
        fast: '120ms',   // hover feedback
        base: '200ms',   // most transitions
        slow: '320ms',   // page-level entrances
      },
      transitionTimingFunction: {
        'out-quart': 'cubic-bezier(0.25, 1, 0.5, 1)',
        spring: 'cubic-bezier(0.34, 1.3, 0.64, 1)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(16px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        shimmer: {
          from: { backgroundPosition: '200% 0' },
          to: { backgroundPosition: '-200% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out both',
        'fade-in-up': 'fade-in-up 320ms cubic-bezier(0.25, 1, 0.5, 1) both',
        'scale-in': 'scale-in 200ms cubic-bezier(0.25, 1, 0.5, 1) both',
        'slide-in-right': 'slide-in-right 320ms cubic-bezier(0.25, 1, 0.5, 1) both',
        shimmer: 'shimmer 1.6s linear infinite',
      },
```

And replace `plugins: [],` with:

```js
  plugins: [require('tailwindcss-animate')],
```

- [ ] **Step 3: Page background + stagger + reduced-motion in globals.css**

Change the `body` rule's background so pages sit on graphite-50 while `--background` (used by inputs, cards, dialogs) stays white:

```css
body {
  min-height: 100vh;
  background: var(--graphite-50);
  color: hsl(var(--foreground));
  font-family: var(--font-display), "Arimo", system-ui, sans-serif;
}
```

Append at the end of the file:

```css
/* Entrance stagger: put .stagger-children on a list/grid container and its
   direct children cascade in. Capped at 12; later children animate together. */
.stagger-children > * {
  animation: fade-in-up 320ms cubic-bezier(0.25, 1, 0.5, 1) both;
}
.stagger-children > *:nth-child(1) { animation-delay: 0ms; }
.stagger-children > *:nth-child(2) { animation-delay: 40ms; }
.stagger-children > *:nth-child(3) { animation-delay: 80ms; }
.stagger-children > *:nth-child(4) { animation-delay: 120ms; }
.stagger-children > *:nth-child(5) { animation-delay: 160ms; }
.stagger-children > *:nth-child(6) { animation-delay: 200ms; }
.stagger-children > *:nth-child(7) { animation-delay: 240ms; }
.stagger-children > *:nth-child(8) { animation-delay: 280ms; }
.stagger-children > *:nth-child(9) { animation-delay: 320ms; }
.stagger-children > *:nth-child(10) { animation-delay: 360ms; }
.stagger-children > *:nth-child(11) { animation-delay: 400ms; }
.stagger-children > *:nth-child(12) { animation-delay: 440ms; }

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint`
Expected: both pass with no new errors.

Run: `npm run dev`, load `/dashboard`.
Expected: page background is faintly gray (graphite-50); white cards now read as raised surfaces; opening any dialog now animates (tailwindcss-animate classes in dialog.tsx are live).

- [ ] **Step 5: Commit**

```bash
git add tailwind.config.js src/app/globals.css package.json package-lock.json
git commit -m "feat(ui): motion vocabulary, depth tokens, graphite page background"
```

---

### Task 2: Button — loading state, pressed feedback, unified focus ring

**Files:**
- Modify: `src/components/ui/button.tsx`

**Interfaces:**
- Produces: `<Button loading>` prop (boolean, optional). Existing `variant`/`size`/`asChild` API unchanged — all current call sites keep compiling.

- [ ] **Step 1: Rewrite button.tsx**

```tsx
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all duration-fast ease-out-quart focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-1 hover:bg-horizon-600 hover:shadow-2",
        destructive:
          "bg-destructive text-destructive-foreground shadow-1 hover:bg-destructive/90",
        outline:
          "border border-input bg-background shadow-1 hover:border-graphite-300 hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-1 hover:bg-graphite-200/70",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  /** Shows a spinner and disables the button. Ignored when asChild. */
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {asChild ? (
          children
        ) : (
          <>
            {loading && <Loader2 className="animate-spin" aria-hidden="true" />}
            {children}
          </>
        )}
      </Comp>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint`
Expected: pass. (`Slot` requires a single child — the `asChild` branch passes `children` through untouched, so existing `<Button asChild><Link/></Button>` call sites still work.)

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/button.tsx
git commit -m "feat(ui): button loading state, pressed scale, unified focus ring"
```

---

### Task 3: Form controls — Input, Textarea, Label error states + unified focus

**Files:**
- Modify: `src/components/ui/input.tsx`
- Modify: `src/components/ui/textarea.tsx`

**Interfaces:**
- Produces: `aria-invalid`-driven error styling on Input and Textarea (no new props — set `aria-invalid` on the element, which callers should be doing for a11y anyway). API otherwise unchanged.

- [ ] **Step 1: Update input.tsx class string**

Replace the `className` string inside `cn(...)` with:

```
"flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors duration-fast file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground hover:border-graphite-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-red-500 aria-[invalid=true]:focus-visible:ring-red-500"
```

- [ ] **Step 2: Update textarea.tsx class string**

Replace the `className` string inside `cn(...)` with:

```
"flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors duration-fast placeholder:text-muted-foreground hover:border-graphite-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-red-500 aria-[invalid=true]:focus-visible:ring-red-500"
```

- [ ] **Step 3: Unify the select trigger focus ring**

In `src/components/ui/select.tsx`, find the `SelectTrigger` class string and replace its focus classes (`focus:outline-none focus:ring-1 focus:ring-ring` or similar) with `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`, and add `transition-colors duration-fast hover:border-graphite-300` alongside the border classes. Touch nothing else in the file — its `animate-in` classes are already live via Task 1's plugin.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/input.tsx src/components/ui/textarea.tsx src/components/ui/select.tsx
git commit -m "feat(ui): unified focus + hover + aria-invalid error states on form controls"
```

---

### Task 4: Card — flat / raised / interactive variants

**Files:**
- Modify: `src/components/ui/card.tsx`

**Interfaces:**
- Produces: `<Card variant="flat" | "raised" | "interactive">`. Default `raised` matches today's look (shadow), so existing call sites are visually unchanged. `interactive` = hover lift for clickable cards. Subcomponents (CardHeader etc.) unchanged.

- [ ] **Step 1: Replace the Card component (keep all subcomponents as-is)**

```tsx
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const cardVariants = cva("rounded-xl border bg-card text-card-foreground", {
  variants: {
    variant: {
      flat: "",
      raised: "shadow-1",
      interactive:
        "shadow-1 transition-all duration-base ease-out-quart hover:-translate-y-px hover:border-graphite-300 hover:shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    },
  },
  defaultVariants: { variant: "raised" },
})

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant, ...props }, ref) => (
    <div ref={ref} className={cn(cardVariants({ variant, className }))} {...props} />
  )
)
Card.displayName = "Card"
```

(Exports line gains nothing new; `CardHeader/Title/Description/Content/Footer` stay byte-identical.)

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint`
Expected: pass — `variant` is optional so existing `<Card>` usage compiles.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/card.tsx
git commit -m "feat(ui): card variants (flat, raised, interactive hover lift)"
```

---

### Task 5: Dialog — brand overlay, blur, deep shadow

**Files:**
- Modify: `src/components/ui/dialog.tsx`

**Interfaces:**
- Consumes: `tailwindcss-animate` utilities (live since Task 1).
- Produces: no API change.

- [ ] **Step 1: Update DialogOverlay class string**

Replace `bg-black/80` with a graphite-tinted blur:

```
"fixed inset-0 z-50 bg-graphite-900/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
```

- [ ] **Step 2: Update DialogContent class string**

In the `DialogContent` `cn(...)` string only, replace `shadow-lg duration-200` with `shadow-4 duration-base` and `sm:rounded-lg` with `sm:rounded-xl`. Everything else stays.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint`
Expected: pass. In the dev server, open any dialog (e.g. connections page): blurred graphite backdrop, zoom-fade entrance, deep soft shadow.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/dialog.tsx
git commit -m "feat(ui): dialog backdrop blur, graphite scrim, elevation-4 shadow"
```

---

### Task 6: Tabs — animated sliding indicator (installs `motion`)

**Files:**
- Modify: `src/components/ui/tabs.tsx`
- Modify: `src/components/providers/client-providers.tsx`
- Modify: `package.json` (via npm install)

**Interfaces:**
- Produces: same Tabs API (`Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` with `value`/`defaultValue`/`onValueChange`), now with a spring-sliding active pill. `MotionConfig reducedMotion="user"` mounted globally (all later `motion` usage inherits it).

- [ ] **Step 1: Install motion**

```bash
npm install motion
```

- [ ] **Step 2: Rewrite tabs.tsx**

```tsx
"use client"

import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { motion } from "motion/react"

import { cn } from "@/lib/utils"

// Track the active value + a per-instance layout id so TabsTrigger can render
// a shared-layout indicator that springs between triggers.
const TabsCtx = React.createContext<{ active?: string; layoutId: string }>({
  layoutId: "",
})

const Tabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(({ defaultValue, value, onValueChange, ...props }, ref) => {
  const [internal, setInternal] = React.useState(defaultValue)
  const layoutId = React.useId()
  return (
    <TabsCtx.Provider value={{ active: value ?? internal, layoutId }}>
      <TabsPrimitive.Root
        ref={ref}
        defaultValue={defaultValue}
        value={value}
        onValueChange={(v) => {
          setInternal(v)
          onValueChange?.(v)
        }}
        {...props}
      />
    </TabsCtx.Provider>
  )
})
Tabs.displayName = TabsPrimitive.Root.displayName

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex h-10 items-center justify-center rounded-lg bg-graphite-100 p-1 text-graphite-600",
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, value, children, ...props }, ref) => {
  const { active, layoutId } = React.useContext(TabsCtx)
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      value={value}
      className={cn(
        "relative inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium text-graphite-600 transition-colors duration-fast hover:text-graphite-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-graphite-900",
        className
      )}
      {...props}
    >
      {active === value && (
        <motion.span
          layoutId={`${layoutId}-indicator`}
          className="absolute inset-0 rounded-md bg-white shadow-1"
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
          aria-hidden="true"
        />
      )}
      <span className="relative z-10">{children}</span>
    </TabsPrimitive.Trigger>
  )
})
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 animate-fade-in ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
```

- [ ] **Step 3: Mount MotionConfig in client-providers.tsx**

```tsx
'use client'

import { Toaster } from 'sonner'
import { MotionConfig } from 'motion/react'
import { SupabaseProvider } from './supabase-provider'

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <SupabaseProvider>
        {children}
        <Toaster richColors />
      </SupabaseProvider>
    </MotionConfig>
  )
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint`
Expected: pass. Dev server: any tabbed view — active pill springs between triggers instead of teleporting. If a consumer renders Tabs without `defaultValue` or `value`, the indicator simply doesn't render until first selection (acceptable).

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/tabs.tsx src/components/providers/client-providers.tsx package.json package-lock.json
git commit -m "feat(ui): spring-animated tabs indicator, global reduced-motion config"
```

---

### Task 7: Badge — brand status variants

**Files:**
- Modify: `src/components/ui/badge.tsx`

**Interfaces:**
- Produces: new `variant` values `good | warn | risk | info` mapped to the brand `--status-*` fills. Existing variants untouched.

- [ ] **Step 1: Add variants + soften the base**

Replace the `badgeVariants` definition with:

```tsx
const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow-1",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow-1",
        outline: "text-foreground",
        good: "border-transparent bg-[var(--status-good-bg)] text-[var(--status-good-fg)]",
        warn: "border-transparent bg-[var(--status-warn-bg)] text-[var(--status-warn-fg)]",
        risk: "border-transparent bg-[var(--status-risk-bg)] text-[var(--status-risk-fg)]",
        info: "border-transparent bg-[var(--status-info-bg)] text-[var(--status-info-fg)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)
```

(Also removes the odd `hover:bg-primary/80` hovers — badges aren't buttons.)

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/badge.tsx
git commit -m "feat(ui): badge status variants on brand status fills"
```

---

### Task 8: Sonner toasts — brand styling

**Files:**
- Modify: `src/components/providers/client-providers.tsx`

**Interfaces:**
- Produces: no API change; all existing `toast()` calls pick up the styling.

- [ ] **Step 1: Replace the `<Toaster richColors />` line**

```tsx
        <Toaster
          richColors
          position="bottom-right"
          toastOptions={{
            classNames: {
              toast:
                'rounded-lg border border-border bg-background text-foreground shadow-3 font-sans',
              description: 'text-muted-foreground',
              actionButton: 'bg-primary text-primary-foreground',
              cancelButton: 'bg-muted text-muted-foreground',
            },
          }}
        />
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint`
Expected: pass. Dev server: trigger any toast (e.g. save an agent config) — branded card with deep-blue shadow.

- [ ] **Step 3: Commit**

```bash
git add src/components/providers/client-providers.tsx
git commit -m "feat(ui): brand-styled sonner toasts"
```

**MILESTONE:** run `npm run build` here. Expected: clean build.

---

### Task 9: New primitives — Skeleton + EmptyState

**Files:**
- Create: `src/components/ui/skeleton.tsx`
- Create: `src/components/ui/empty-state.tsx`

**Interfaces:**
- Produces: `<Skeleton className="h-4 w-32" />` (div, shimmer, shape via className). `<EmptyState icon={Inbox} title="No signals yet" description="…" action={<Button>…</Button>} />` — `icon` is an optional `LucideIcon`, `action` an optional ReactNode.

- [ ] **Step 1: skeleton.tsx**

```tsx
import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-shimmer rounded-md bg-gradient-to-r from-graphite-100 via-graphite-200 to-graphite-100 bg-[length:200%_100%]",
        className
      )}
      aria-hidden="true"
      {...props}
    />
  )
}

export { Skeleton }
```

- [ ] **Step 2: empty-state.tsx**

```tsx
import * as React from "react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
}

function EmptyState({ icon: Icon, title, description, action, className, ...props }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-graphite-200 bg-graphite-50/50 px-6 py-12 text-center animate-fade-in",
        className
      )}
      {...props}
    >
      {Icon && (
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-horizon-50 text-horizon-600">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
      )}
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export { EmptyState }
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/skeleton.tsx src/components/ui/empty-state.tsx
git commit -m "feat(ui): skeleton shimmer and empty-state primitives"
```

---

### Task 10: New primitives — Tooltip + DropdownMenu

**Files:**
- Create: `src/components/ui/tooltip.tsx`
- Create: `src/components/ui/dropdown-menu.tsx`
- Modify: `package.json` (via npm install)

**Interfaces:**
- Produces: standard shadcn APIs — `TooltipProvider`, `Tooltip`, `TooltipTrigger`, `TooltipContent`; `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuLabel`, `DropdownMenuSeparator`. (YAGNI: no checkbox/radio/sub-menu parts.)

- [ ] **Step 1: Install**

```bash
npm install @radix-ui/react-tooltip @radix-ui/react-dropdown-menu
```

- [ ] **Step 2: tooltip.tsx**

```tsx
"use client"

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider
const Tooltip = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-md bg-graphite-900 px-3 py-1.5 text-xs text-white shadow-popover animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
```

- [ ] **Step 3: dropdown-menu.tsx**

```tsx
"use client"

import * as React from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"

import { cn } from "@/lib/utils"

const DropdownMenu = DropdownMenuPrimitive.Root
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-[8rem] overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-popover data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        className
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
))
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors duration-fast focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
      className
    )}
    {...props}
  />
))
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn("px-2 py-1.5 text-xs font-semibold text-muted-foreground", className)}
    {...props}
  />
))
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-border", className)}
    {...props}
  />
))
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
}
```

- [ ] **Step 4: Verify + commit**

Run: `npm run typecheck && npm run lint`
Expected: pass.

```bash
git add src/components/ui/tooltip.tsx src/components/ui/dropdown-menu.tsx package.json package-lock.json
git commit -m "feat(ui): tooltip and dropdown-menu primitives"
```

---

### Task 11: New primitive — Table

**Files:**
- Create: `src/components/ui/table.tsx`

**Interfaces:**
- Produces: `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`, `TableCaption`. `Table` accepts `stickyHeader?: boolean`. Numeric cells: callers add `className="font-mono tabular-nums"` to `TableCell`.

- [ ] **Step 1: table.tsx**

```tsx
import * as React from "react"

import { cn } from "@/lib/utils"

interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  stickyHeader?: boolean
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, stickyHeader = false, ...props }, ref) => (
    <div className={cn("relative w-full overflow-auto rounded-xl border bg-card shadow-1", stickyHeader && "max-h-[70vh]")}>
      <table
        ref={ref}
        className={cn("w-full caption-bottom text-sm", stickyHeader && "[&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10", className)}
        {...props}
      />
    </div>
  )
)
Table.displayName = "Table"

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <thead ref={ref} className={cn("bg-graphite-50 [&_tr]:border-b", className)} {...props} />
  )
)
TableHeader.displayName = "TableHeader"

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
  )
)
TableBody.displayName = "TableBody"

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn("border-b transition-colors duration-fast hover:bg-graphite-50/70 data-[state=selected]:bg-horizon-50", className)}
      {...props}
    />
  )
)
TableRow.displayName = "TableRow"

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn("h-10 px-4 text-left align-middle font-mono text-[11px] font-bold uppercase tracking-wider text-muted-foreground", className)}
      {...props}
    />
  )
)
TableHead.displayName = "TableHead"

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn("px-4 py-3 align-middle", className)} {...props} />
  )
)
TableCell.displayName = "TableCell"

const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(
  ({ className, ...props }, ref) => (
    <caption ref={ref} className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
  )
)
TableCaption.displayName = "TableCaption"

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption }
```

- [ ] **Step 2: Verify + commit**

Run: `npm run typecheck && npm run lint`
Expected: pass.

```bash
git add src/components/ui/table.tsx
git commit -m "feat(ui): designed table primitive (mono headers, row hover, sticky option)"
```

---

### Task 12: New primitives — StatTile + PageHeader

**Files:**
- Create: `src/components/ui/stat-tile.tsx`
- Create: `src/components/ui/page-header.tsx`

**Interfaces:**
- Consumes: `Card` variants (Task 4), `motion` (Task 6), `.eyebrow` helper class (exists in backstory-design.css).
- Produces: `<StatTile label value hint? icon? />` (`value: number | string`; numbers count up), `<PageHeader eyebrow? title description? actions? />`.

- [ ] **Step 1: stat-tile.tsx**

```tsx
"use client"

import * as React from "react"
import { animate } from "motion"
import { useReducedMotion } from "motion/react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Card } from "@/components/ui/card"

function AnimatedNumber({ value }: { value: number }) {
  const ref = React.useRef<HTMLSpanElement>(null)
  const reduced = useReducedMotion()
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    if (reduced) {
      el.textContent = value.toLocaleString()
      return
    }
    const controls = animate(0, value, {
      duration: 0.8,
      ease: [0.25, 1, 0.5, 1],
      onUpdate: (v) => {
        el.textContent = Math.round(v).toLocaleString()
      },
    })
    return () => controls.stop()
  }, [value, reduced])
  return <span ref={ref} className="tabular-nums" />
}

interface StatTileProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string
  value: number | string
  hint?: string
  icon?: LucideIcon
}

function StatTile({ label, value, hint, icon: Icon, className, ...props }: StatTileProps) {
  return (
    <Card variant="raised" className={cn("p-5", className)} {...props}>
      <div className="flex items-start justify-between gap-3">
        <p className="eyebrow">{label}</p>
        {Icon && <Icon className="h-4 w-4 text-horizon-500" aria-hidden="true" />}
      </div>
      <p className="mt-2 font-mono text-3xl font-bold text-foreground">
        {typeof value === "number" ? <AnimatedNumber value={value} /> : value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  )
}

export { StatTile }
```

- [ ] **Step 2: page-header.tsx**

```tsx
import * as React from "react"

import { cn } from "@/lib/utils"

interface PageHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  eyebrow?: string
  title: string
  description?: string
  actions?: React.ReactNode
}

function PageHeader({ eyebrow, title, description, actions, className, ...props }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4 animate-fade-in-up", className)} {...props}>
      <div className="space-y-1">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="text-2xl font-bold leading-9 tracking-tight text-foreground">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export { PageHeader }
```

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck && npm run lint`
Expected: pass.

```bash
git add src/components/ui/stat-tile.tsx src/components/ui/page-header.tsx
git commit -m "feat(ui): stat-tile with animated count and page-header primitives"
```

---

### Task 13: Command palette (⌘K) — installs `cmdk`, mounts in AppShell

**Files:**
- Create: `src/components/ui/command-palette.tsx`
- Modify: `src/components/layout/app-shell.tsx`
- Modify: `package.json` (via npm install)

**Interfaces:**
- Consumes: Dialog primitives (Task 5).
- Produces: `<CommandPalette />` self-contained (own open state, own ⌘K/ctrl+K listener). Mounted once inside AppShell's authenticated branch. Overlay component — zero layout impact.

- [ ] **Step 1: Install cmdk**

```bash
npm install cmdk
```

- [ ] **Step 2: command-palette.tsx**

```tsx
"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Command } from "cmdk"
import {
  LayoutDashboard,
  Radio,
  FileText,
  Plug,
  Blocks,
  Search,
} from "lucide-react"

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

const NAV_ITEMS = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Signals", href: "/signals", icon: Radio },
  { label: "Templates", href: "/templates", icon: FileText },
  { label: "Connections", href: "/connections", icon: Plug },
  { label: "Integrations", href: "/integrations", icon: Blocks },
]

export function CommandPalette() {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [])

  const go = (href: string) => {
    setOpen(false)
    router.push(href)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[30%] max-w-xl translate-y-0 gap-0 p-0 overflow-hidden">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command label="Command palette" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground">
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Command.Input
              placeholder="Go to…"
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Command.List className="max-h-72 overflow-y-auto p-1.5">
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
              No results.
            </Command.Empty>
            <Command.Group heading="Navigate">
              {NAV_ITEMS.map(({ label, href, icon: Icon }) => (
                <Command.Item
                  key={href}
                  value={label}
                  onSelect={() => go(href)}
                  className="flex cursor-default select-none items-center gap-2 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                >
                  <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  {label}
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: Mount in app-shell.tsx**

Add the import and render `<CommandPalette />` inside the authenticated branch, next to `<Sidebar />`:

```tsx
import { CommandPalette } from '@/components/ui/command-palette'
```

```tsx
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <CommandPalette />
      <Sidebar />
      ...
```

- [ ] **Step 4: Verify + commit**

Run: `npm run typecheck && npm run lint`
Expected: pass. Dev server on `/dashboard`: press ⌘K → palette opens, arrow keys navigate, enter routes.

```bash
git add src/components/ui/command-palette.tsx src/components/layout/app-shell.tsx package.json package-lock.json
git commit -m "feat(ui): cmd-k command palette"
```

**MILESTONE:** run `npm run build` here. Expected: clean build. Layer 2 complete.

---

## Layer 3 — In-place application (layout frozen)

The remaining tasks share one method. For each screen: **read the file(s) first**, then apply these recipes to elements *in their existing positions*. Never move, regroup, or restructure content. Recipes:

- **R1 — Loading:** any manual spinner / "Loading…" text / blank-while-fetching region → `Skeleton` blocks approximating the loaded content's shape (e.g. a card grid gets `<Skeleton className="h-32 rounded-xl" />` per slot).
- **R2 — Empty:** any "No X yet" / bare text empty branch → `EmptyState` with a relevant lucide icon, sentence-case title, one-line description, and the existing CTA (if one exists) as `action`.
- **R3 — Entrance:** the screen's main list/grid container gets `stagger-children` (only on containers whose children are stable on load; skip containers that re-render on poll, or the animation replays).
- **R4 — Clickable cards:** cards that navigate or open dialogs → `<Card variant="interactive">`; static cards stay `raised`.
- **R5 — Status text:** inline colored status text/pills → `<Badge variant="good|warn|risk|info">` by meaning.
- **R6 — Header:** if the page already has a heading block, re-render it through `PageHeader` in the same position (eyebrow = section name, e.g. "Workspace"); pass existing buttons as `actions`. If the heading structure differs too much, leave it — do not force.
- **R7 — Metrics:** existing numeric summary widgets → `StatTile` in the same grid cell. Only where a metric widget already exists.
- **R8 — Tables:** hand-rolled `<table>` or row-list markup that is semantically a table → `Table` primitives, same columns, same order. Numeric columns get `font-mono tabular-nums`.
- **R9 — Buttons with in-flight state:** submit/connect buttons that disable during async work → use the new `loading` prop instead of manual spinner markup.

Verification for every screen task: `npm run typecheck && npm run lint`, then load the route in the dev server and confirm (a) layout is pixel-equivalent aside from the new polish, (b) loading/empty/hover/entrance states behave, (c) no console errors. Commit per task with the message given.

---

### Task 14: App shell + sidebar polish

**Files:**
- Modify: `src/components/layout/sidebar.tsx` (529 lines — read fully first)
- Modify: `src/components/layout/app-shell.tsx`

**Work:**
- [ ] Sidebar nav links: add `transition-colors duration-fast`, a clear active treatment using existing tokens (`bg-horizon-50 text-horizon-700` active; `hover:bg-graphite-100` inactive) — matching whatever active-detection logic already exists; do not change nav order or grouping.
- [ ] Sidebar footer (if a user/settings block exists): wrap long labels with `Tooltip` where text truncates.
- [ ] Add a small "⌘K" keyboard hint next to any existing search affordance in the sidebar — text `⌘K` in `font-mono text-[11px] text-muted-foreground border border-border rounded px-1`. If no search affordance exists, skip (layout freeze).
- [ ] In `app-shell.tsx`, give the non-fullscreen content wrapper an entrance: add `animate-fade-in` to the `container` div. (Not `fade-in-up` — avoid scroll-position jumps.)
- [ ] Verify + commit: `git commit -m "feat(shell): sidebar active states, transitions, content entrance"`

### Task 15: Dashboard

**Files:**
- Modify: `src/app/dashboard/page.tsx` (534 lines — read fully first)
- Modify: `src/app/dashboard/agent-activity-pane.tsx`, `src/app/dashboard/assistant-panel.tsx`, `src/app/dashboard/agent-config-dialog.tsx`, `src/app/dashboard/agent-config-form.tsx` (read each before editing)

**Work:**
- [ ] Apply R1 (skeletons for every async region), R2, R3 (main widget container), R4, R6, R7 (existing metric widgets → StatTile), R9 (config form submit).
- [ ] Activity feed items (agent-activity-pane): add `animate-fade-in` on new items and `transition-colors` hover on rows. Timestamps and counts get `font-mono tabular-nums text-xs text-muted-foreground`.
- [ ] Verify + commit: `git commit -m "feat(dashboard): skeletons, stat tiles, entrance motion, empty states"`

### Task 16: Signals

**Files:**
- Modify: `src/app/signals/page.tsx` (387 lines — read fully first)

**Work:**
- [ ] Apply R1, R2, R3, R5 (signal severity/status → Badge variants: healthy/positive → `good`, warnings → `warn`, risks/errors → `risk`, neutral/informational → `info`), R6, R8 (signal list → Table if tabular).
- [ ] Verify + commit: `git commit -m "feat(signals): designed table, status badges, loading and empty states"`

### Task 17: Templates

**Files:**
- Modify: `src/app/templates/page.tsx` (385 lines — read fully first)
- Modify: `src/app/templates/[id]/page.tsx` (read fully first)

**Work:**
- [ ] List page: R1, R2 (empty state with existing "create" CTA as action), R3 on the card grid, R4 (template cards → `interactive`), R6.
- [ ] Detail page: R1, R6, R9 on any save/run actions; markdown/body regions untouched.
- [ ] Verify + commit: `git commit -m "feat(templates): interactive cards, stagger, designed empty state"`

### Task 18: Connections + Integrations

**Files:**
- Modify: `src/app/connections/page.tsx` (285 lines), `src/app/connections/mcp-connection-dialog.tsx`
- Modify: `src/app/integrations/granola-card.tsx`, `src/app/integrations/people-ai-card.tsx`, `src/app/integrations/oauth-integrations-grid.tsx`, plus `src/app/integrations/page.tsx` if present (read each first)

**Work:**
- [ ] Apply R1, R2, R3, R5 (connected/disconnected/error status → `good`/`secondary`/`risk` badges), R6, R9 (connect/disconnect buttons get `loading`).
- [ ] Integration cards stay in their grid; give clickable ones `variant="interactive"` (R4).
- [ ] Verify + commit: `git commit -m "feat(connections): status badges, loading buttons, card polish"`

### Task 19: Auth + Connect (first-run)

**Files:**
- Modify: `src/app/auth/login/page.tsx`, `src/app/auth/signup/page.tsx`, `src/app/connect/page.tsx` (read each first)

**Work:**
- [ ] Background treatment on the existing outer wrapper only: `bg-gradient-horizon-soft` (utility exists in tailwind.config). Card containing the form gets `shadow-3` and `animate-fade-in-up`. Structure unchanged.
- [ ] R9 on submit buttons; inputs inherit Task 3 focus/error states automatically — wire `aria-invalid` on fields that already track error state.
- [ ] Verify + commit: `git commit -m "feat(auth): horizon gradient backdrop, card elevation, loading submits"`

### Task 20: Landing page

**Files:**
- Modify: `src/app/page.tsx` (272 lines — read fully first), `src/app/landing.css` (read first)

**Work:**
- [ ] Sections and order preserved exactly. Within them: hero gets `bg-gradient-horizon-soft` or `gradient-horizon` treatment if a flat background exists today; primary CTAs re-rendered through `Button` (lg) if hand-rolled; feature cards get `variant="interactive"` hover lift; section entrances get `animate-fade-in-up` on their existing wrappers.
- [ ] Type polish inside existing elements only: headings adopt `.h1`/`.h2`/`.h3` helpers or equivalent tracking/leading utilities; eyebrow labels adopt `.eyebrow`.
- [ ] Verify + commit: `git commit -m "feat(landing): gradient hero, interactive cards, type polish"`

### Task 21: Final verification

- [ ] Run: `npm run check` (typecheck + lint + build). Expected: all pass.
- [ ] Dev server run-through of every route: `/`, `/auth/login`, `/auth/signup`, `/connect`, `/dashboard`, `/signals`, `/templates`, `/templates/[id]`, `/connections`, `/integrations`. Confirm per-route: layout unchanged, states present, motion smooth, no console errors.
- [ ] Toggle "reduce motion" in OS accessibility settings; confirm animations collapse.
- [ ] Commit any fixes: `git commit -m "fix(ui): final polish pass"`
