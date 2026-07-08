export const AGENT_RUN_MAX_DURATION_SECONDS = 20 * 60
export const AGENT_RUN_TIMEOUT_MS = AGENT_RUN_MAX_DURATION_SECONDS * 1000

// Keep a single model turn below the enclosing 20 minute execution window so
// persistence/cleanup still has room to finish.
export const AGENT_MODEL_TURN_TIMEOUT_MS = 19 * 60 * 1000

