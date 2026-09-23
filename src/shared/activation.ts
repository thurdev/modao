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
 * Only the phrasings these readmes actually use are recognised - the pt-BR
 * "digite / digitando / escreva", "use o código", "código de ativação", and
 * their English mirrors "type / typing", "enter", "use the code", "activation
 * code", "cheat code". Nothing here guesses at a format the authors do not
 * write, and nothing here reads a keypress ("aperte F5") as a code.
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

/** The verbs and noun phrases that introduce a code in these readmes. */
const TRIGGER = String.raw`\b(?:digit(?:e|em|ar|ando|a)|escreva|escrevendo|use\s+o\s+c[óo]digo|c[óo]digo\s+de\s+ativa[çc][ãa]o|c[óo]digo\s+para\s+ativar|typing|type|enter|use\s+the\s+code|activation\s+code|cheat\s+code)\b`

/**
 * Words that may sit between the verb and the code: "digite o código TAGS",
 * "type the cheat TAGS", "digite no jogo TAGS". Each alternative ends on a word
 * boundary - without it "the code AEZAKMI" loses its A to the filler's own "a".
 */
const FILLER = String.raw`(?:\s+(?:o|a|os|as|the|este|esse|esta|this|seguinte|following|c[óo]digo|codigo|code|cheat|comando|command|trapa[çc]a|no\s+jogo|em\s+jogo|durante\s+o\s+jogo|in\s*-?\s*game|ingame)\b)*`

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
      const token = (m[1] ?? m[2] ?? '').trim()
      if (!isActivationCode(token)) continue
      const key = token.toUpperCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ code: token, line })
    }
  }
  return out
}

function isActivationCode(token: string): boolean {
  if (token.length < 2 || token.length > 24) return false
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
