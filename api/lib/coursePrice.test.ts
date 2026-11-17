import assert from 'node:assert/strict'
import test from 'node:test'
import { formatFreeCourseAnswer, hasFreeCoursePrice } from './coursePrice.js'
import { createSearchIndex, searchIndex } from './searchIndex.js'
import { buildSystemPrompt, generateDbAgentAnswer } from './dbChat.js'

test('recognizes explicit zero prices without mistaking positive prices for free', () => {
  for (const price of ['$0', '$0.00 MXN', '0 pesos', '0', 'Online: 0 / Presencial: $500', 'Online: $0 MXN / Presencial: $500']) {
    assert.equal(hasFreeCoursePrice(price), true, price)
  }
  for (const price of ['', '$0.01', '$100', 'Online: $50 / Presencial: $500']) {
    assert.equal(hasFreeCoursePrice(price), false, price)
  }
})

test('zero course prices are presented as free without changing positive prices or other offers', () => {
  assert.equal(formatFreeCourseAnswer('El curso virtual tiene un costo de $0 MXN.', true, false), 'El curso virtual es gratis.')
  assert.equal(formatFreeCourseAnswer('Online: $0.00 MXN; presencial: $500 MXN.', true, false), 'Online: gratis; presencial: $500 MXN.')
  assert.equal(formatFreeCourseAnswer('Precio: 0 pesos.', true, false), 'es gratis.')
  assert.equal(formatFreeCourseAnswer('Precio: $0 MXN.', false, false), 'Precio: $0 MXN.')
  assert.equal(formatFreeCourseAnswer('El producto cuesta $0 MXN.', true, true), 'El producto cuesta $0 MXN.')
  assert.equal(formatFreeCourseAnswer('Precio: $0.01 MXN.', true, false), 'Precio: $0.01 MXN.')
})

test('free course searches include the free modality and preserve paid prices', () => {
  const index = createSearchIndex({
    tenantId: 'school',
    documents: [{
      id: 'courses', title: 'cursos.md', docType: 'cursos', section: 'cursos',
      isActive: true, updatedAt: '2026-01-01T00:00:00Z',
      content: [
        '[CURSO]', 'Nombre del curso: Python', 'Modalidades: Online, Presencial', 'Precio: Online: $0 MXN / Presencial: $500 MXN', '',
        '[CURSO]', 'Nombre del curso: Java', 'Modalidades: Online', 'Precio: $700 MXN',
      ].join('\n'),
    }],
  })
  const free = searchIndex(index, '¿tienen cursos gratis?')
  assert.match(free.contextBlock, /Python/)
  assert.match(free.contextBlock, /Online: \$0 MXN \/ Presencial: \$500 MXN/)
  assert.doesNotMatch(free.contextBlock, /Java/)
  const near = searchIndex(index, 'cursos de 100 pesos')
  assert.match(near.contextBlock, /precios van de \$0 a \$700/)
  const prompt = buildSystemPrompt('', free.contextBlock)
  assert.match(prompt, /curso o de una modalidad del curso.*es cero/)
  assert.match(prompt, /No apliques esta regla a productos/)
})

test('a chat response describes a free online course without a numeric zero price', async () => {
  const keys = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'LLM_API_KEY', 'LLM_BASE_URL'] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.SUPABASE_URL = 'https://supabase.test'
  process.env.SUPABASE_SECRET_KEY = 'test-secret'
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon'
  process.env.LLM_API_KEY = 'test-llm'
  process.env.LLM_BASE_URL = 'https://model.test'
  const originalFetch = globalThis.fetch
  let judgeInput = ''
  let modelCalls = 0
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === 'supabase.test') {
      return Response.json([{
        id: 'courses', tenant_id: 'school', title: 'cursos.md', doc_type: 'markdown',
        content_markdown: '[CURSO]\nNombre del curso: Python\nModalidades: Online, Presencial\nPrecio: Online: $0 MXN / Presencial: $500 MXN',
        is_active: true, updated_at: '2026-01-01T00:00:00Z',
      }])
    }
    assert.equal(url.hostname, 'model.test')
    const body = JSON.parse(String(init?.body))
    modelCalls += 1
    const text = body.messages.map((message: { content: string }) => message.content).join('\n')
    if (modelCalls > 1) judgeInput = text
    const answer = modelCalls === 1
      ? 'El curso de Python online tiene un costo de $0 MXN. La modalidad presencial cuesta $500 MXN.'
      : JSON.stringify({ category: 'correct', reason: 'Respaldado por los documentos.' })
    return Response.json({ choices: [{ message: { content: answer }, finish_reason: 'stop' }] })
  }
  try {
    const result = await generateDbAgentAnswer({
      tenantId: 'school',
      prompt: 'Responde con los documentos del negocio.',
      message: '¿Tienen cursos gratis?',
      history: [],
    }, { autocuratorEnabled: false })
    assert.equal(result.answer, 'El curso de Python online es gratis. La modalidad presencial cuesta $500 MXN.')
    assert.match(judgeInput, /El curso de Python online es gratis/)
  } finally {
    globalThis.fetch = originalFetch
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
})
