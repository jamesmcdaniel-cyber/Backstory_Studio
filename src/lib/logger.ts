export const apiLogger = {
  error(message: string, meta?: Record<string, unknown>) {
    console.error(`[api] ${message}`, meta || '')
  },
  warn(message: string, meta?: Record<string, unknown>) {
    console.warn(`[api] ${message}`, meta || '')
  },
}
