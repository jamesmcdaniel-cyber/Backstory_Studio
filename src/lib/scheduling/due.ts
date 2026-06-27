/**
 * Pure, side-effect-free scheduling due-check.
 * No external dependencies — uses only built-in Intl APIs.
 */

export type AgentSchedule = {
  type: 'manual' | 'hourly' | 'daily' | 'weekly' | 'cron'
  /** HH:MM – used by daily and weekly */
  time: string
  /** Standard 5-field cron expression – used by type === 'cron' */
  cron: string
  /** IANA timezone string, e.g. "America/New_York" */
  timezone: string
  isActive: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads the current date-time components for a given instant in the supplied
 * IANA timezone, using Intl.DateTimeFormat.
 */
function zoneParts(instant: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const p = fmt.formatToParts(instant)
  const get = (type: string) => Number(p.find((x) => x.type === type)!.value)
  return {
    year: get('year'),
    month: get('month'),   // 1-based
    day: get('day'),
    hour: get('hour'),     // 0–23
    minute: get('minute'),
    second: get('second'),
    // day-of-week 0 (Sun)–6 (Sat)
    dow: new Date(get('year'), get('month') - 1, get('day')).getDay(),
  }
}

/**
 * Returns the UTC timestamp for HH:MM today in the given timezone.
 * "Today" is determined by what `now` looks like in that zone.
 */
function todayInstant(hhmm: string, tz: string, now: Date): Date {
  const [hh, mm] = hhmm.split(':').map(Number)
  const p = zoneParts(now, tz)

  // Build the local-to-UTC mapping by constructing the calendar instant.
  // We use a dummy Date in UTC with the zone's Y/M/D and the desired H:M,
  // then measure how far off Intl reports it, and correct.
  const naive = Date.UTC(p.year, p.month - 1, p.day, hh, mm, 0, 0)
  const naiveDate = new Date(naive)
  const check = zoneParts(naiveDate, tz)
  const diffMs =
    ((hh - check.hour) * 60 + (mm - check.minute)) * 60_000
  return new Date(naive + diffMs)
}

// ---------------------------------------------------------------------------
// Minimal 5-field cron matcher
// Supports: * | */n | comma lists | ranges (a-b) for each field
// Fields: minute hour dom month dow
// ---------------------------------------------------------------------------

function matchField(expr: string, value: number, min: number, _max: number): boolean {
  for (const part of expr.split(',')) {
    if (part === '*') return true
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10)
      if (!isNaN(step) && step > 0 && (value - min) % step === 0) return true
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number)
      if (value >= lo && value <= hi) return true
    } else {
      if (parseInt(part, 10) === value) return true
    }
  }
  return false
}

/**
 * Returns true if `now` matches the 5-field cron expression
 * (evaluated in the given timezone).
 */
function matchesCron(expr: string, tz: string, now: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [minF, hourF, domF, monF, dowF] = fields
  const p = zoneParts(now, tz)
  return (
    matchField(minF, p.minute, 0, 59) &&
    matchField(hourF, p.hour, 0, 23) &&
    matchField(domF, p.day, 1, 31) &&
    matchField(monF, p.month, 1, 12) &&
    matchField(dowF, p.dow, 0, 6)
  )
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Returns true when the agent with the given schedule is due to run.
 *
 * Pure function — has no side effects; safe to call in tight loops.
 */
export function isDue(
  schedule: AgentSchedule,
  lastExecutedAt: Date | null,
  now: Date,
): boolean {
  if (!schedule.isActive) return false
  if (schedule.type === 'manual') return false

  switch (schedule.type) {
    case 'hourly': {
      if (lastExecutedAt === null) return true
      return now.getTime() - lastExecutedAt.getTime() >= 60 * 60_000
    }

    case 'daily': {
      const scheduled = todayInstant(schedule.time || '00:00', schedule.timezone || 'UTC', now)
      if (now < scheduled) return false
      if (lastExecutedAt === null) return true
      return lastExecutedAt < scheduled
    }

    case 'weekly': {
      if (lastExecutedAt !== null) {
        const sevenDaysMs = 7 * 24 * 60 * 60_000
        if (now.getTime() - lastExecutedAt.getTime() < sevenDaysMs) return false
      }
      // Also require that now is past today's scheduled time
      const scheduled = todayInstant(schedule.time || '00:00', schedule.timezone || 'UTC', now)
      if (now < scheduled) return false
      return true
    }

    case 'cron': {
      if (!schedule.cron) return false
      return matchesCron(schedule.cron, schedule.timezone || 'UTC', now)
    }

    default:
      return false
  }
}
