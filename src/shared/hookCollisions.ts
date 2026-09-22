import { normalizeAddress } from './crash'

/**
 * A plugin-sdk .asi built with no source encodes the addresses it hooks as
 * mangled template args in its own symbol table (see ./mangled). If two
 * different mods hook the same address, only one hook survives at runtime -
 * the loser's feature silently does nothing, or worse, both trampolines
 * fight over the same bytes. Nothing else in the app can see this before it
 * shows up as an unexplained crash or a mod that "does nothing".
 *
 * Pure: takes the addresses each plugin was already found to hook, decides
 * nothing about where those plugins live on disk. The caller
 * (src/main/conflicts/index.ts) reads the binaries and does the I/O.
 */
export interface HookCollisionCandidate {
  /** The mod's title, as shown everywhere else in the app. */
  title: string
  /** The .asi file this evidence came from, for the detail line. */
  file: string
  addresses: number[]
}

export interface HookCollision {
  /** "0x0053E981" */
  address: string
  claimants: { title: string; file: string }[]
}

export function findHookCollisions(candidates: HookCollisionCandidate[]): HookCollision[] {
  const byAddress = new Map<number, { title: string; file: string }[]>()
  for (const c of candidates) {
    for (const addr of c.addresses) {
      const list = byAddress.get(addr)
      if (list) list.push({ title: c.title, file: c.file })
      else byAddress.set(addr, [{ title: c.title, file: c.file }])
    }
  }

  const out: HookCollision[] = []
  for (const [addr, claimants] of byAddress) {
    // Two files of the SAME mod hooking one address is normal (a plugin can
    // ship several .asi files); it is only a collision across mods.
    if (new Set(claimants.map((c) => c.title)).size > 1) {
      out.push({ address: normalizeAddress(addr), claimants })
    }
  }
  return out.sort((a, b) => a.address.localeCompare(b.address))
}
