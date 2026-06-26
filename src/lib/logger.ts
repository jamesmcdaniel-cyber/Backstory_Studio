export const apiLogger = {
  error(message: string, meta?: Record<string, unknown>) {
    console.error(`[api] ${message}`, meta || '')
  },
}
