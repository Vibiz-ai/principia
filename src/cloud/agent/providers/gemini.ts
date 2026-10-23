/** Gemini CLI credentials in a run (CLOUD.md §7.2): an AI Studio API key, or a Vertex service account. */
import { join } from 'node:path'
import type { ProviderMaterial } from '../../contract'
import type { RunSandbox } from '../sandbox'
import type { ProviderSetup } from './materialize'

export const GEMINI_API_KEY_RE = /^[A-Za-z0-9_-]{30,}$/

interface ServiceAccount { type?: string; project_id?: string; client_email?: string; private_key?: string }
const parseAccount = (text: string): ServiceAccount | null => {
  try {
    const o = JSON.parse(text) as unknown
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as ServiceAccount) : null
  } catch {
    return null
  }
}

/**
 * gemini_api_key -> GEMINI_API_KEY. google_service_account -> the JSON in the run home (0600),
 * GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_GENAI_USE_VERTEXAI=true and the project. The CLI's auth choice goes in the
 * run's own ~/.gemini/settings.json, so it never asks.
 */
export function materializeGemini(box: RunSandbox, m: ProviderMaterial): ProviderSetup {
  if (m.kind === 'gemini_api_key') {
    return {
      env: { GEMINI_API_KEY: m.value.trim() },
      files: [{ path: join(box.geminiDir, 'settings.json'), content: `${JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }, null, 2)}\n` }]
    }
  }
  if (m.kind === 'google_service_account') {
    const sa = parseAccount(m.value)
    const file = join(box.geminiDir, 'service-account.json')
    return {
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: file,
        GOOGLE_GENAI_USE_VERTEXAI: 'true',
        ...(sa?.project_id ? { GOOGLE_CLOUD_PROJECT: sa.project_id } : {}),
        GOOGLE_CLOUD_LOCATION: 'us-central1'
      },
      files: [
        { path: file, content: m.value },
        { path: join(box.geminiDir, 'settings.json'), content: `${JSON.stringify({ security: { auth: { selectedType: 'vertex-ai' } } }, null, 2)}\n` }
      ]
    }
  }
  throw new Error(`Gemini cannot use a ${m.kind} credential`)
}

export function geminiShapeProblem(m: ProviderMaterial): string | null {
  if (m.kind === 'gemini_api_key') return GEMINI_API_KEY_RE.test(m.value.trim()) ? null : "That doesn't look like a Gemini API key. Copy it from Google AI Studio."
  if (m.kind === 'google_service_account') {
    const sa = parseAccount(m.value)
    return sa?.type === 'service_account' && sa.client_email && sa.private_key?.includes('PRIVATE KEY') && sa.project_id
      ? null
      : "That isn't a Google service account file. Download the JSON key of a service account with Vertex AI access."
  }
  return 'Gemini uses a Gemini API key or a service account file.'
}
