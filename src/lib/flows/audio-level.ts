/** RMS of an 8-bit time-domain sample buffer (0 = silence, ~1 = full scale).
 *  Drives the "speaking" pulse on huddle avatars. */
export function rmsLevel(samples: Uint8Array): number {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] - 128) / 128
    sum += v * v
  }
  return Math.sqrt(sum / samples.length)
}

/** Above this RMS a participant is rendered as speaking. Tuned for typical
 *  mic gain; a quiet room idles ~0.01, speech peaks well above 0.05. */
export const SPEAKING_THRESHOLD = 0.04
