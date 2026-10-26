/** The persona names the phone has a line-art bust for (src/cloud/console/busts.gen.ts is generated from PERSONAS). */
import { PERSONAS } from '../../shared/personas'

export const BUST_NAMES: ReadonlySet<string> = new Set(PERSONAS.map((p) => p.name))
