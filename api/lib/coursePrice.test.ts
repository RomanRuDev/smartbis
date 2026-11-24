import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { formatFreeCourseAnswer, hasFreeCoursePrice } from './coursePrice.js'
import { createSearchIndex, searchIndex } from './searchIndex.js'
import { buildSystemPrompt, findContradictoryFreeCoursePrice, generateDbAgentAnswer } from './dbChat.js'

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

test('zero prices are checked against the named course and modality', () => {
  const index = createSearchIndex({ tenantId: 'prices', documents: [{
    id: 'courses', title: 'cursos.md', docType: 'cursos', section: 'cursos',
    isActive: true, updatedAt: '2026-01-01T00:00:00Z',
    content: `[CURSO]
Nombre del curso: Lipoenzimas
Precio: Online: $595 MXN ($33 USD) / Presencial: $1350 MXN
[CURSO]
Nombre del curso: Python
Precio: Online: $0 MXN ($10 USD) / Presencial: $500 MXN
[CURSO]
Nombre del curso: Sin precio`,
  }] })
  assert.match(String(findContradictoryFreeCoursePrice('Curso Lipoenzimas\n\nEl costo online es de $0 MXN aproximadamente $0 USD.', index)), /Lipoenzimas.*en línea/)
  assert.match(String(findContradictoryFreeCoursePrice('Curso Lipoenzimas\nEl costo presencial es de $0 MXN.', index)), /presencial/)
  assert.match(String(findContradictoryFreeCoursePrice('Curso Lipoenzimas\nEl curso es gratis.', index)), /Lipoenzimas/)
  assert.match(String(findContradictoryFreeCoursePrice('Curso Python\nEl costo presencial es de $0 MXN.', index)), /Python.*presencial/)
  assert.equal(findContradictoryFreeCoursePrice('Curso Python\nEl costo online es de $0 MXN.', index), null)
  assert.match(String(findContradictoryFreeCoursePrice('Curso Python\nEl costo online es de $0 USD.', index)), /Python/)
  const lipoenzimas = index.blocks.find((block) => block.fields.name === 'Lipoenzimas')!
  assert.match(String(findContradictoryFreeCoursePrice('El costo online es de $0 MXN.', index, lipoenzimas)), /Lipoenzimas/)
  assert.equal(findContradictoryFreeCoursePrice('Curso Lipoenzimas\nPrecio online: $595 MXN.', index), null)
  assert.equal(findContradictoryFreeCoursePrice('Curso Lipoenzimas\nEl curso no es gratis.', index), null)
  assert.equal(findContradictoryFreeCoursePrice('Curso Sin precio\nPrecio online: $0 MXN.', index), null)
})

test('a fabricated free course price is blocked even when the judge approves or autocuration is disabled', async () => {
  const keys = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'LLM_API_KEY', 'LLM_BASE_URL'] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.SUPABASE_URL = 'https://supabase.test'
  process.env.SUPABASE_SECRET_KEY = 'test-secret'
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon'
  process.env.LLM_API_KEY = 'test-llm'
  process.env.LLM_BASE_URL = 'https://model.test'
  const tenantId = `incorrect-price-${randomUUID()}`
  const storePath = path.resolve(process.cwd(), 'clientsdata', '_meta_store', `pos_${tenantId}.json`)
  const originalFetch = globalThis.fetch
  let modelCalls = 0
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'supabase.test') return Response.json([{
      id: 'courses', tenant_id: tenantId, title: 'cursos.md', doc_type: 'markdown', is_active: true,
      updated_at: '2026-01-01T00:00:00Z',
      content_markdown: `[CURSO]
Nombre del curso: Lipoenzimas
Precio: Online: $595 MXN ($33 USD) / Presencial: $1350 MXN
[CURSO]
Nombre del curso: Mesobotox
Precio: Online: $595 MXN ($33 USD) / Presencial: $1350 MXN`,
    }])
    assert.equal(url.hostname, 'model.test')
    modelCalls += 1
    const answer = modelCalls % 2 === 1
      ? 'Curso Lipoenzimas\n\nEl costo presencial es de $0 MXN.\n\nEl costo online es de $0 MXN aproximadamente $0 USD.\n\nCurso Mesobotox\n\nEl costo online es de $0 MXN.'
      : JSON.stringify({ category: 'correct', reason: 'Aprobado por el juez.' })
    return Response.json({ choices: [{ message: { content: answer }, finish_reason: 'stop' }] })
  }
  try {
    const input = {
      tenantId, prompt: '', message: 'Si con gusto, 760 482-8294',
      history: [{ role: 'user' as const, content: 'Si la de mesoterapia para grasa localizada y reafirmante' }],
    }
    for (const autocuratorEnabled of [true, false]) {
      const result = await generateDbAgentAnswer(input, { autocuratorEnabled })
      assert.equal(result.autoEval.blocked, true)
      assert.equal(result.autoEval.category, 'error')
      assert.match(result.autoEval.judgeReason, /precio gratuito.*contradice su ficha/i)
    }
  } finally {
    globalThis.fetch = originalFetch
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
  }
})
