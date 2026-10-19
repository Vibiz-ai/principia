/** Tests never see the real home dir: anything a test shells out to gets a throwaway $HOME. Live smoke tests opt out. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.HIVE_REAL_CLAUDE) {
  const home = mkdtempSync(join(tmpdir(), 'hive-test-home-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
}
