/**
 * White or invisible cars and peds: a model loaded from one mod and its
 * textures from another.
 *
 * A GTA San Andreas model is two files that have to travel together - the mesh
 * in `<name>.dff` and the textures it names in `<name>.txd`. Mod Loader
 * resolves each file on its own, by priority, so nothing stops it from taking
 * `infernus.dff` from one mod and `infernus.txd` from another. The mesh then
 * asks for texture names the winning `.txd` does not contain and the game
 * draws the model with no texture at all: a white car, a white ped, or - where
 * the mesh itself is the one that lost - nothing visible where the vehicle
 * should be.
 *
 * It is not a file conflict in the sense `src/main/conflicts/index.ts` means:
 * the two files have DIFFERENT relative paths, so no path is claimed twice and
 * the per-path index is structurally blind to it. What is duplicated is the
 * MODEL, one half at a time.
 *
 * The same symptom has a second, unrelated cause: a streaming memory budget
 * too small for the models installed makes the streamer drop textures it
 * cannot hold, and every affected vehicle turns white too. That one is not
 * fixed by priority, and the two must not be conflated - the check below only
 * ever fires when a `.dff` and its `.txd` genuinely resolve to different
 * installs, which a starved budget never causes. The budget is checked
 * elsewhere (`src/main/game/streamIni.ts`, `SAFE_STREAMING_MEMORY_MB`).
 *
 * Free of Electron, of the database and of the filesystem, like
 * ./duplicateAssets.ts and ./limitAdjusters.ts: the caller reads the `provides`
 * rows and hands them over, and supplies Mod Loader's own winner rule so this
 * module never has to restate it.
 */

/** One half of a model, as one install supplies it. */
export interface ModelPart {
  installId: number
  /** Mod title, for the finding. */
  title: string
  /** Mod Loader folder name - the tie-break when two priorities are equal. */
  folder: string
  /** Path the file is indexed under, e.g. "models/infernus.dff". */
  relativePath: string
  priority: number
  enabled: boolean
}

export interface SplitModel<T extends ModelPart = ModelPart> {
  /** Shared base name of the pair, lower-cased: "infernus". */
  stem: string
  /** The install Mod Loader loads the mesh from. */
  dff: T
  /** The install Mod Loader loads the textures from - a different one. */
  txd: T
  /**
   * Every install supplying either half of this model, winners included. The
   * fix is a priority change on one of them, so all of them are offered.
   */
  claimants: T[]
  /**
   * Installs that ship BOTH halves themselves. A split can only happen when at
   * least one mod shipped the pair together and something outbid one half of
   * it, so this is never empty - and naming it is what makes the finding
   * readable: "Cool Cars ships both, but its .txd lost to Shiny Paint".
   */
  shippedTogether: T[]
}

function baseName(relativePath: string): string {
  return (relativePath.split(/[\\/]/).pop() ?? '').toLowerCase()
}

/** "models/infernus.dff" -> "infernus", or null when it is neither half of a model. */
export function modelStem(relativePath: string): { stem: string; half: 'dff' | 'txd' } | null {
  const name = baseName(relativePath)
  const m = /^(.+)\.(dff|txd)$/.exec(name)
  if (!m || !m[1]) return null
  return { stem: m[1], half: m[2] as 'dff' | 'txd' }
}

/**
 * Groups `.dff`/`.txd` rows by model name and reports every model whose two
 * halves Mod Loader would load from different mods.
 *
 * A finding requires that some single install ships both halves. Two mods that
 * each ship only one half are a deliberate pairing - a mesh pack plus a
 * retexture is how half the scene distributes its work - and flagging that
 * would bury the real failure in noise. The failure this catches is narrower
 * and always a mistake: a mod shipped a matched pair, another mod outbid one
 * of the two, and the halves the game ends up with were never made for each
 * other.
 *
 * `pickWinner` is Mod Loader's own rule (`resolveWinner` in
 * `src/main/game/modloaderIni.ts`): highest priority wins, priority 0 or a
 * disabled mod is out entirely, ties fall back to folder order.
 */
export function findSplitModels<T extends ModelPart>(
  parts: T[],
  pickWinner: (candidates: T[]) => T | null
): SplitModel<T>[] {
  const halves = new Map<string, { dff: T[]; txd: T[] }>()
  for (const p of parts) {
    const id = modelStem(p.relativePath)
    if (!id) continue
    let entry = halves.get(id.stem)
    if (!entry) {
      entry = { dff: [], txd: [] }
      halves.set(id.stem, entry)
    }
    entry[id.half].push(p)
  }

  const out: SplitModel<T>[] = []
  for (const [stem, entry] of halves) {
    if (entry.dff.length === 0 || entry.txd.length === 0) continue
    const dff = pickWinner(entry.dff)
    const txd = pickWinner(entry.txd)
    // No winner at all means every claimant is disabled or at priority 0 and
    // the game uses its own file for that half - nothing is split.
    if (!dff || !txd || dff.installId === txd.installId) continue

    const dffIds = new Set(entry.dff.map((p) => p.installId))
    const shippedTogether = entry.txd.filter((p) => dffIds.has(p.installId))
    if (shippedTogether.length === 0) continue

    const claimants: T[] = []
    const seen = new Set<number>()
    for (const p of [...entry.dff, ...entry.txd]) {
      if (seen.has(p.installId)) continue
      seen.add(p.installId)
      claimants.push(p)
    }
    out.push({ stem, dff, txd, claimants, shippedTogether })
  }
  return out.sort((a, b) => a.stem.localeCompare(b.stem))
}
