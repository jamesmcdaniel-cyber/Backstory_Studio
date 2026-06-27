export const EXECUTION_MODE = process.env.EXECUTION_MODE || 'inline'
export const inlineExecution = EXECUTION_MODE !== 'queue'
