import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { budget } from './src/test/timing'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['src/test/isolateHome.ts'],
    // vitest's 5 s / 10 s defaults, scaled like every other time limit (src/test/timing.ts) so a busy machine doesn't time out
    testTimeout: budget(5_000),
    hookTimeout: budget(10_000)
  }
})
