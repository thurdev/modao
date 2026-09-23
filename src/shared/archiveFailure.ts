/**
 * What a failed extraction actually means, read off 7-Zip's own output.
 *
 * The extractor is spawned in the main process, but deciding WHY it failed is
 * pure string work over the child's output, and the unit suite cannot load
 * Electron - so the verdict lives here with the other pure ones and
 * `install/archive.ts` is left doing nothing but the spawning.
 *
 * Every signature below was read off the bundled `7za.exe` (21.07, the reduced
 * `path7za` build), not off the documentation. The exact lines, all of them on
 * stderr except where noted:
 *
 *   encrypted .7z, wrong/empty password
 *     ERROR: Data Error in encrypted file. Wrong password? : src\a.txt
 *   encrypted .zip, wrong/empty password
 *     ERROR: Wrong password : src\a.txt
 *   header-encrypted .7z (-mhe=on), wrong/empty password
 *     ERROR: <name>
 *     Cannot open encrypted archive. Wrong password?
 *     ERRORS:
 *     Headers Error
 *     Can't open as archive: 1        (stdout)
 *   bytes that are not an archive at all
 *     ERROR: <name>
 *     ERRORS:
 *     Is not archive
 *   a format this binary has no decoder for - .rar is the one that matters
 *     ERROR: <name>
 *     Cannot open the file as archive
 *
 * Note what the header-encrypted case costs if it is not recognised: 7-Zip
 * cannot even read the file list, so it reports a headers error, and a mod
 * manager that repeats that verbatim tells the user their download is corrupt.
 * They re-download, and the second copy fails in exactly the same way.
 */

/** Why an extraction failed, as far as the output can say. */
export type ArchiveFailure =
  /** The archive opened; its contents would not decrypt. */
  | 'wrong-password'
  /** The file list itself is encrypted, so nothing could even be read. */
  | 'encrypted-headers'
  /** A .rar: the bundled 7za has no RAR decoder and never will. */
  | 'rar-unsupported'
  /** The bytes are broken. Re-downloading is the honest advice here. */
  | 'corrupt'
  /** Failed for a reason the output does not name. */
  | 'unknown'

const WRONG_PASSWORD = /wrong password/i
const ENCRYPTED_HEADERS = /headers error|cannot open encrypted archive/i
const CANNOT_OPEN = /can'?t open as archive|cannot open the file as archive|is not archive/i
const BROKEN_DATA = /data error|crc failed|unexpected end of (archive|data)|unavailable data/i

/** Whether this name is one the bundled extractor cannot open whatever we do. */
export function isRarName(file: string): boolean {
  return /\.rar$/i.test(file.trim())
}

/**
 * Classify one failed run.
 *
 * Order matters. The password signatures are tested before the RAR name,
 * deliberately: with the bundled `7za` a .rar can never produce one (it cannot
 * parse the container far enough to know it is encrypted), so the order costs
 * nothing today - and if a full 7-Zip build is ever bundled, an encrypted .rar
 * is then classified as encrypted rather than as unsupported, which is the
 * answer that would be true at that point.
 *
 * `output` should be stderr and stdout together: the password lines come over
 * stderr, `Can't open as archive` over stdout.
 */
export function classifyArchiveFailure(output: string, archive = ''): ArchiveFailure {
  const text = output ?? ''
  if (ENCRYPTED_HEADERS.test(text)) return 'encrypted-headers'
  if (WRONG_PASSWORD.test(text)) return 'wrong-password'
  if (isRarName(archive) && CANNOT_OPEN.test(text)) return 'rar-unsupported'
  if (CANNOT_OPEN.test(text) || BROKEN_DATA.test(text)) return 'corrupt'
  return 'unknown'
}

/** The two failures a password can still rescue. */
export function isPasswordFailure(failure: ArchiveFailure): boolean {
  return failure === 'wrong-password' || failure === 'encrypted-headers'
}

/**
 * Whether to try again with the MixMods password.
 *
 * Only when the failure was about a password AND the caller had no password of
 * its own to offer. A caller that did supply one has already had it refused;
 * guessing over the top of an answer the user gave us would be rude, and would
 * hide which of the two passwords was actually wrong.
 */
export function shouldRetryWithPassword(failure: ArchiveFailure, suppliedPassword?: string): boolean {
  if (suppliedPassword) return false
  return isPasswordFailure(failure)
}
