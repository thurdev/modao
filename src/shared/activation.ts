/**
 * Activation codes a readme tells the player to type in-game.
 *
 * A good number of MixMods scripts install perfectly and then appear to do
 * nothing, because they only wake up once a cheat-style code is typed during
 * play - "Para ativar, digite TAGS". The code is in the readme and nowhere
 * else: not in the file names, not in the binary, not in modloader.log. A mod
 * nobody told you how to turn on is indistinguishable from a mod that failed to
 * install, so the code is pulled out of the prose and carried on the mod.
 *
 * Every phrasing here is one this project's own scraped corpus (index/sa.json)
 * actually contains; the first draft recognised six more that read plausibly
 * and appear nowhere, which is the same invention this parser exists to avoid.
 * What the corpus attests:
 *
 *   digitar / digite / digitando  "Para ativar digite “CLAYMORE”"
 *                                 "Digitando “TIMESTOP” o relógio do jogo vai parar."
 *                                 "digitar (como cheat) “BKMR1” até “BKMR9”"
 *   escrever                      "Basta escrever “FPS” e o mod se ativará."
 *   type                          the English mirror of digite, for the
 *                                 "Readme (or die).txt" half of these archives.
 *                                 The corpus is the pt-BR blog, so it carries
 *                                 the word only as a noun ("Infernus Type R",
 *                                 `data-mce-type="bookmark"`); none of those 23
 *                                 lines yields a code, and a test holds that.
 *
 * Dropped for want of evidence: "escreva" (the corpus's only hits are
 * "Escreva-se no canal" - subscribe), "typing", "enter" (every corpus hit is a
 * keypress: "pressione Enter"), "use o código", "código de ativação", "código
 * para ativar", "use the code", "activation code", "cheat code". A keypress
 * ("aperte F5") is still not read as a code.
 *
 * Pure on purpose: no fs, no electron, so the unit suite can exercise it and
 * the renderer can run it over readme text it already has.
 */

export interface ActivationCode {
  /** The code exactly as the readme spells it. */
  code: string
  /** The author's own line, kept so the user can read the context. */
  line: string
}

/**
 * The verbs that introduce a code. Three, each one attested above. The
 * preceding character may not be a hyphen, which is what keeps the corpus's
 * slugs and HTML attributes ("infernus-type-r", `data-mce-type=`) out.
 */
const TRIGGER = String.raw`(?<![-\w])(?:digit(?:e|em|ar|ando|a)|escrever|type)\b`

/**
 * What the authors put between the verb and the code: "digitar o comando
 * abort", "digitar (como cheat) “BKMR1”", "type the code TAGS". Each
 * alternative ends on a word boundary - without it "the code AEZAKMI" loses its
 * A to the filler's own "a".
 */
const FILLER = String.raw`(?:\s+(?:(?:o|a|os|as|the|c[óo]digo|codigo|code|cheats?|comando|command|no\s+jogo|in\s*-?\s*game)\b|\([^)\r\n]{0,24}\)))*`

/** Quoted, or bare. Case is judged afterwards, so the regex can stay `i`. */
const CODE = String.raw`(?:["“”'«»]\s*([^"“”'«»\r\n]{2,24}?)\s*["“”'«»]|([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9_+!-]{1,23}))`

const ACTIVATION_RE = new RegExp(`${TRIGGER}${FILLER}\\s*[:=]?\\s*${CODE}`, 'gi')

/** A code is written in capitals, because that is how it is typed in-game. */
const CODE_SHAPE = /^[A-ZÀ-ÖØ-Þ0-9][A-ZÀ-ÖØ-Þ0-9 _+!-]{1,23}$/

/**
 * Capitalised words that follow "digite" / "type" without being a code: keys,
 * answers, file kinds, and the names of the things being talked about.
 */
const NOT_A_CODE = new Set([
  'NAO',
  'NÃO',
  'SIM',
  'YES',
  'NO',
  'OK',
  'THE',
  'AND',
  'OU',
  'OR',
  'ENTER',
  'ESC',
  'ESCAPE',
  'TAB',
  'CTRL',
  'ALT',
  'SHIFT',
  'SPACE',
  'DEL',
  'INS',
  'GTA',
  'SA',
  'MOD',
  'MODS',
  'CLEO',
  'ASI',
  'TXD',
  'DFF',
  'IMG',
  'INI',
  'CFG',
  'TXT',
  'EXE',
  'DLL',
  'README',
  'LEIAME',
  'MODLOADER',
  'PC',
  'HD',
  'URL',
  'HTTP',
  'HTTPS',
  'WWW'
])

/**
 * Every activation code stated in a readme, in the order the author wrote them.
 *
 * The code and its line are returned verbatim - these files are Windows-1252
 * and the sentence around the code is usually accented Portuguese, which has to
 * survive intact for the user to read it back.
 */
export function extractActivationCodes(text: string): ActivationCode[] {
  const out: ActivationCode[] = []
  const seen = new Set<string>()
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.length > 400) continue
    ACTIVATION_RE.lastIndex = 0
    for (const m of line.matchAll(ACTIVATION_RE)) {
      const quoted = m[1] !== undefined
      const token = (m[1] ?? m[2] ?? '').trim()
      if (!isActivationCode(token, quoted)) continue
      const key = token.toUpperCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ code: token, line })
    }
  }
  return out
}

function isActivationCode(token: string, quoted: boolean): boolean {
  // Quotes are the author's own delimiter, so two characters inside them are
  // believable. Unquoted, two capitals are prose: the corpus's "se você
  // escrever UU." is about a mark on the map, not a cheat. Every code the
  // corpus does state is three characters or more.
  if (token.length < (quoted ? 2 : 3) || token.length > 24) return false
  // A path or a file name is never a cheat code, and "digite o nome do
  // arquivo" is a sentence about one.
  if (/[\\/.]/.test(token)) return false
  if (!CODE_SHAPE.test(token)) return false
  // At most three words: "THUG TOOLS" happens, a sentence does not.
  const words = token.split(/\s+/)
  if (words.length > 3) return false
  if (!/[A-ZÀ-ÖØ-Þ]/.test(token)) return false
  // A key, not a code.
  if (/^F\d{1,2}$/.test(token)) return false
  return !words.every((w) => NOT_A_CODE.has(w))
}
