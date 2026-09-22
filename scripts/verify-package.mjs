/**
 * Reads the built archive the way Electron does and refuses to ship it if the
 * bytes do not line up.
 *
 * This exists because a shipped build once died before it could log anything:
 * one packed file was recorded one byte shorter than it was written, every
 * entry after it was off by one, and Electron got the tail of a JavaScript
 * bundle where package.json should have been - "Unexpected token '`'". The app
 * never opened and there was no way to tell why from inside it.
 */
import fs from 'node:fs'
import path from 'node:path'

const unpacked = process.argv[2] ?? path.join('dist', 'win-unpacked')
const asarPath = path.join(unpacked, 'resources', 'app.asar')
const problems = []

if (!fs.existsSync(asarPath)) {
  console.error(`No archive at ${asarPath}`)
  process.exit(1)
}

const buf = fs.readFileSync(asarPath)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
const base = 16 + headerSize

/** Pulls one file out of the archive exactly as Electron's asar reader would. */
function read(entry) {
  const start = base + Number(entry.offset)
  return buf.subarray(start, start + Number(entry.size))
}

function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const full = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, full)
    else if (!entry.unpacked) check(full, entry)
  }
}

function check(name, entry) {
  const bytes = read(entry)
  if (bytes.length !== Number(entry.size)) {
    problems.push(`${name}: archive ends before the recorded size (${bytes.length} of ${entry.size} bytes)`)
    return
  }
  if (name === 'package.json') {
    try {
      const pkg = JSON.parse(bytes.toString('utf8'))
      if (!pkg.main) problems.push('package.json has no "main" entry point')
      if (!fs.existsSync(path.join(unpacked, 'resources', 'app.asar'))) problems.push('archive vanished mid-check')
    } catch (e) {
      problems.push(`package.json does not parse: ${e.message}`)
      problems.push(`  first bytes: ${JSON.stringify(bytes.subarray(0, 80).toString('utf8'))}`)
    }
  }
  // The entry points must start where JavaScript starts, not mid-token.
  if (name.endsWith('.js') && name.startsWith('out/')) {
    const head = bytes.subarray(0, 2).toString('utf8')
    if (head.startsWith('`') || head.startsWith('}')) {
      problems.push(`${name}: starts mid-token (${JSON.stringify(head)}) - the archive offsets are shifted`)
    }
  }
}

walk(header, '')

const entryPoints = ['package.json', 'out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']
for (const name of entryPoints) {
  const parts = name.split('/')
  let node = header
  for (const part of parts) node = node?.files?.[part]
  if (!node) problems.push(`${name} is missing from the archive`)
}

if (problems.length) {
  console.error(`\n${asarPath} is not shippable:\n`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}

const count = JSON.stringify(header).match(/"size":/g)?.length ?? 0
console.log(`archive verified: ${count} files, package.json and every entry point read back cleanly`)
