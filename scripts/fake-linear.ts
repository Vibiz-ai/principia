/**
 * LINEAR.md §7: run the fake Linear on its own for QA (Node 23.6+ runs this file directly).
 *
 *   FAKE_LINEAR_KEY=lin_api_fake_qa_key_000000 node scripts/fake-linear.ts      # serves http://127.0.0.1:8765/graphql
 *   PRINCIPIA_LINEAR_API=http://127.0.0.1:8765/graphql HIVE_USER_DATA=… npx electron-vite dev
 *
 * Teams Engineering (ENG, estimates on) and Design (DES), seven ENG issues. Admin routes: GET /__log, GET /__issues,
 * POST /__admin {"op":"edit","key":"ENG-1","fields":{"priority":1}} | {"op":"revoke"} | {"op":"restore"} | {"op":"clearLog"}.
 */
import { FakeLinear, startFakeLinear } from '../src/main/company/sync/fakeLinear.ts'

const key = process.env.FAKE_LINEAR_KEY || 'lin_api_fake_qa_key_0000000000000'
const port = Number(process.env.FAKE_LINEAR_PORT || 8765)
const fake = new FakeLinear({ key })
const { url } = await startFakeLinear(fake, port)
console.log(`fake Linear on ${url} (${fake.issues.length} issues, key ${key.slice(0, 8)}…)`)
