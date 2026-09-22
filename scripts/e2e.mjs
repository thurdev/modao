/* Builds, then runs the headless end-to-end self-check in a throwaway userData. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const build = spawnSync('npx', ['electron-vite', 'build'], { stdio: 'inherit', shell: true })
if (build.status !== 0) process.exit(build.status ?? 1)

const dir = mkdtempSync(path.join(tmpdir(), 'modao-e2e-run-'))
const saves = path.join(dir, 'saves')
mkdirSync(saves, { recursive: true })

const run = spawnSync('npx', ['electron', '.', `--user-data-dir=${path.join(dir, 'userdata')}`], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, MODAO_SMOKE: '2', MODAO_USER_FILES: saves }
})
rmSync(dir, { recursive: true, force: true })
process.exit(run.status ?? 1)
