import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { GatewayService } from '../main/gateway/service'
import { processCipher } from './agent/gateway'
const connection = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), name: z.string().min(1).max(120), transport: z.enum(['stdio', 'http']), command: z.string().optional(), args: z.array(z.string()).optional(), url: z.string().url().optional(), enabled: z.boolean(), roots: z.array(z.string()).min(1), credentials: z.record(z.string(), z.string()).optional() })
export function createCloudGateway(dataDir: string, workspace: string, baseEnv: () => Record<string, string>, addSecret: (value: string) => void) {
  const configPath = process.env.PRINCIPIA_MCP_CONFIG
  const keyHex = process.env.PRINCIPIA_MCP_MASTER_KEY
  if (!configPath && !keyHex) return undefined
  if (!keyHex || !/^[a-fA-F0-9]{64}$/.test(keyHex)) throw new Error('PRINCIPIA_MCP_MASTER_KEY must be a 32-byte hex key')
  const key = Buffer.from(keyHex, 'hex'); addSecret(keyHex)
  const gateway = new GatewayService({ userData: dataDir, mainDir: dirname(fileURLToPath(import.meta.url)), bridgePath: resolve(dirname(fileURLToPath(import.meta.url)), 'mcp-gateway.mjs'), baseEnv, vault: { addRedactions: (_name, value) => addSecret(value) }, cipher: processCipher(key) })
  try {
    if (configPath) {
      const configs = z.array(connection).max(100).parse(JSON.parse(readFileSync(configPath, 'utf8')))
      for (const config of configs) {
        for (const root of config.roots) { const path = realpathSync(root); if (path !== workspace && !path.startsWith(workspace + sep)) throw new Error('MCP project roots must stay inside cloud workspace') }
        for (const value of Object.values(config.credentials ?? {})) addSecret(value)
        gateway.save(config)
      }
      for (const saved of gateway.list()) if (!configs.some(c => c.id === saved.id)) gateway.remove(saved.id)
    }
    return gateway
  } catch (e) { gateway.close(); throw e }
}
