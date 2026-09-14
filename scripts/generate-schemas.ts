import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { schemaDocuments } from '../src/schema.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')
let stale = false

for (const [name, schema] of Object.entries(schemaDocuments)) {
  const path = join(root, 'schemas', name)
  const expected = `${JSON.stringify(schema, null, 2)}\n`
  if (check) {
    let actual: string | undefined
    try {
      actual = await readFile(path, 'utf8')
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    if (actual !== expected) {
      process.stderr.write(`stale: schemas/${name}\n`)
      stale = true
    }
  } else {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, expected, 'utf8')
  }
}

if (stale) process.exitCode = 1
