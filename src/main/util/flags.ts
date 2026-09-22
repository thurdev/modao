/**
 * The switch an elevated restart passes to its replacement. The new instance
 * uses it to wait for the outgoing one to release the single-instance lock
 * instead of assuming another copy is already running and quitting.
 */
export const ELEVATED_FLAG = '--modao-elevated-restart'

export function isElevatedRestart(argv: string[]): boolean {
  return argv.includes(ELEVATED_FLAG)
}
