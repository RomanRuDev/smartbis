import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDbDocumentsContextBlock, buildSystemPrompt, generateDbAgentAnswer } from './dbChat.js'
import { createSearchIndex } from './searchIndex.js'
import type { WorkspaceDocument } from './workspace.js'

function document(id: string, title: string, section: WorkspaceDocument['section'], content: string): WorkspaceDocument {
  return { id, title, docType: section, section, content, isActive: true, updatedAt: '2026-01-01T00:00:00Z' }
}

test('a general services question includes the current business description alongside its catalog', () => {
  const index = createSearchIndex({
    tenantId: 'school',
    documents: [
      document('general', 'infogeneral.md', 'general', '[DESCRIPCION]\nEnseñamos programación en Python y JavaScript.'),
      document('courses', 'cursos.md', 'cursos', '[CURSO]\nNombre del curso: Python\nPrecio: $500'),
      document('inactive', 'old.md', 'general', '[DESCRIPCION]\nOfrecemos medicina estética.'),
    ].map((doc) => doc.id === 'inactive' ? { ...doc, isActive: false } : doc),
  })

  const result = buildDbDocumentsContextBlock(index, '¿Qué servicios brindan?')
  assert.match(result.contextBlock, /programación en Python y JavaScript/)
  assert.match(result.contextBlock, /Python/)
  assert.doesNotMatch(result.contextBlock, /medicina estética/)
  assert.ok(result.matchedBlocks.some((block) => block.body.includes('programación en Python')))
  const prompt = buildSystemPrompt('Eres un asistente.', result.contextBlock)
  assert.match(prompt, /programación en Python y JavaScript/)
  assert.doesNotMatch(prompt, /Mesobotox|Lipoenzimas|Fibroblast|Toxina Botulínica|\$595/)
})

test('business descriptions remain isolated and general data is not added to specific catalog questions', () => {
  const makeIndex = (tenantId: string, description: string) => createSearchIndex({
    tenantId,
    documents: [
      document(`${tenantId}-general`, 'infogeneral.md', 'general', `[DESCRIPCION]\n${description}`),
      document(`${tenantId}-courses`, 'cursos.md', 'cursos', '[CURSO]\nNombre del curso: Python\nPrecio: $500'),
    ],
  })
  const school = makeIndex('school', 'Enseñamos programación.')
  const music = makeIndex('music', 'Enseñamos música.')
  const schoolContext = buildDbDocumentsContextBlock(school, '¿Qué servicios ofrecen?')
  const musicContext = buildDbDocumentsContextBlock(music, '¿Qué servicios ofrecen?')
  assert.match(schoolContext.contextBlock, /Enseñamos programación/)
  assert.doesNotMatch(schoolContext.contextBlock, /Enseñamos música/)
  assert.match(musicContext.contextBlock, /Enseñamos música/)
  assert.doesNotMatch(musicContext.contextBlock, /Enseñamos programación/)
  assert.doesNotMatch(buildDbDocumentsContextBlock(school, 'precio del curso Python').businessFacts, /Enseñamos programación/)
})

test('an unstructured general document is included in an offer overview', () => {
  const index = createSearchIndex({
    tenantId: 'school-unstructured',
    documents: [
      document('general', 'infogeneral.md', 'general', 'Nuestra empresa ofrece cursos de programación para principiantes.'),
      document('courses', 'cursos.md', 'cursos', '[CURSO]\nNombre del curso: Python\nPrecio: $500'),
    ],
  })
  const result = buildDbDocumentsContextBlock(index, '¿Qué servicios brindan?')
  assert.match(result.contextBlock, /cursos de programación para principiantes/)
  assert.ok(result.matchedBlocks.some((block) => block.body.includes('cursos de programación')))
})

test('the chat request and judge receive the selected tenant business description', async () => {
  const keys = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'LLM_API_KEY', 'LLM_BASE_URL'] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.SUPABASE_URL = 'https://supabase.test'
  process.env.SUPABASE_SECRET_KEY = 'test-secret'
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon'
  process.env.LLM_API_KEY = 'test-llm'
  process.env.LLM_BASE_URL = 'https://model.test'
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === 'supabase.test') {
      assert.equal(url.searchParams.get('tenant_id'), 'eq.school')
      return Response.json([
        { id: 'general', tenant_id: 'school', title: 'infogeneral.md', doc_type: 'markdown', content_markdown: '[DESCRIPCION]\nEnseñamos programación en Python.', is_active: true, updated_at: '2026-01-01T00:00:00Z' },
        { id: 'courses', tenant_id: 'school', title: 'cursos.md', doc_type: 'markdown', content_markdown: '[CURSO]\nNombre del curso: Python\nPrecio: $500', is_active: true, updated_at: '2026-01-01T00:00:00Z' },
      ])
    }
    assert.equal(url.hostname, 'model.test')
    const body = JSON.parse(String(init?.body))
    const text = body.messages.map((message: { content: string }) => message.content).join('\n')
    requests.push(text)
    const answer = requests.length === 1
      ? 'Ofrecemos cursos de programación en Python.'
      : JSON.stringify({ category: 'correct', reason: 'Respaldado por los documentos.' })
    return Response.json({ choices: [{ message: { content: answer }, finish_reason: 'stop' }] })
  }
  try {
    const result = await generateDbAgentAnswer({
      tenantId: 'school',
      prompt: 'Responde con los documentos del negocio.',
      message: '¿Qué servicios brindan?',
      history: [],
    }, { autocuratorEnabled: false })
    assert.equal(result.answer, 'Ofrecemos cursos de programación en Python.')
    assert.ok(result.sources.some((source) => source.id === 'general'))
    assert.equal(requests.length, 2)
    for (const request of requests) assert.match(request, /Enseñamos programación en Python/)
    assert.doesNotMatch(requests[0], /Mesobotox|Lipoenzimas|Fibroblast|Toxina Botulínica/)
  } finally {
    globalThis.fetch = originalFetch
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
})
