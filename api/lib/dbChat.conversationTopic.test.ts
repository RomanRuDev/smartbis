import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { buildDbDocumentsContextBlock, generateDbAgentAnswer, resolveConversationTopic } from './dbChat.js'
import { correctQueryTypos, createSearchIndex, searchIndex } from './searchIndex.js'
import type { WorkspaceDocument } from './workspace.js'

const courses: WorkspaceDocument = {
  id: 'courses', title: 'cursos.md', docType: 'cursos', section: 'cursos',
  isActive: true, updatedAt: '2026-01-01T00:00:00Z',
  content: `[CURSO]
Nombre del curso: Mesobotox.
Descripción: Técnica de rejuvenecimiento.
Precio: $895 MXN
Horario: 10:00 am a 2:00 pm (Hora local de Hermosillo).

[CURSO]
Nombre del curso: Lipoenzimas.
Descripción: Aplicación de enzimas.
Horario: 1:00 pm a 5:00 pm.`,
}
const products: WorkspaceDocument = {
  ...courses, id: 'products', title: 'productos.md', docType: 'productos', section: 'productos',
  content: `[PRODUCTO]
Nombre del producto: Revofil.
Precio: $700 MXN
Descripción: Producto facial.

[PRODUCTO]
Nombre del producto: Peptonas.
Precio: $300 MXN`,
}
const index = createSearchIndex({ tenantId: 'conversation', documents: [courses, products] })

test('long misspelled names resolve only when the closest catalog name is unambiguous', () => {
  for (const typo of ['mesabotoz', 'mesobtox']) {
    assert.match(searchIndex(index, `tienes curso de ${typo}`).contextBlock, /Mesobotox/)
    const result = buildDbDocumentsContextBlock(index, `horario del curso ${typo}`)
    assert.equal(result.askedSchedule?.schedule, '10:00 am a 2:00 pm (Hora local de Hermosillo).')
  }
  const ambiguous = createSearchIndex({ tenantId: 'ambiguous-typo', documents: [{
    ...courses, content: '[CURSO]\nNombre del curso: Mesobotox\n[CURSO]\nNombre del curso: Mesobotaz',
  }] })
  assert.match(correctQueryTypos(ambiguous, 'mesabotoz'), /mesabotoz/)
})

test('follow-ups use the most recent named item or ad without crossing a topic change', () => {
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: 'tienes curso de lipoenzimas?' },
    { role: 'assistant', content: 'Sí, Lipoenzimas.' },
    { role: 'user', content: 'información del curso de mesabotoz' },
    { role: 'assistant', content: 'La descripción es técnica de rejuvenecimiento.' },
    { role: 'user', content: 'qué descripción tiene el curso' },
    { role: 'assistant', content: 'Es una técnica de rejuvenecimiento.' },
  ]
  const result = resolveConversationTopic(index, 'que horario tiene el curso', history)
  assert.equal(result?.kind, 'selected')
  if (result?.kind === 'selected') assert.match(result.card.fields.name, /Mesobotox/)
  const productHistory = [...history, { role: 'user' as const, content: 'precio del producto Revofil' }]
  const product = resolveConversationTopic(index, 'cuánto cuesta el producto', productHistory)
  assert.equal(product?.kind, 'selected')
  if (product?.kind === 'selected') assert.equal(product.card.fields.name, 'Revofil.')
  assert.equal(resolveConversationTopic(index, 'que horario tiene el curso', productHistory), null)
  assert.equal(resolveConversationTopic(index, 'horario del curso de microblading', history), null)
  assert.equal(resolveConversationTopic(index, 'que horario tiene el curso', [
    ...history, { role: 'user', content: 'tienes curso de microblading?' },
  ]), null)
  const ad = 'El cliente llegó desde este anuncio: ID de anuncio 123 · anuncio Curso Mesobotox'
  const advertised = resolveConversationTopic(index, 'que horario tiene el curso', [], ad)
  assert.equal(advertised?.kind, 'selected')
  if (advertised?.kind === 'selected') assert.match(advertised.card.fields.name, /Mesobotox/)
  const adWithColon = 'El cliente llegó desde este anuncio: ID de anuncio 123 · anuncio ‼️CURSO MESOBOTOX🤩 TE INCLUIMOS: ✅Constancia de participación.'
  const typoInfo = resolveConversationTopic(index, 'Mas informaicon del curso', [], adWithColon)
  assert.equal(typoInfo?.kind, 'selected')
  if (typoInfo?.kind === 'selected') assert.match(typoInfo.card.fields.name, /Mesobotox/)
  const multiple = resolveConversationTopic(index, 'cuanto cuesta', [
    { role: 'user', content: 'Revofil y Peptonas' },
  ])
  assert.equal(multiple?.kind, 'clarify')
  const sameName = createSearchIndex({ tenantId: 'same-name', documents: [courses, {
    ...products, content: '[PRODUCTO]\nNombre del producto: Mesobotox\nPrecio: $400 MXN',
  }] })
  const course = resolveConversationTopic(sameName, 'cuanto cuesta', [
    { role: 'user', content: 'tienes el curso de mesabotoz?' },
  ])
  assert.equal(course?.kind, 'selected')
  if (course?.kind === 'selected') assert.equal(course.card.document.section, 'cursos')
  const productAd = resolveConversationTopic(sameName, 'precio', [], 'Anuncio: anuncio Producto Mesobotox')
  assert.equal(productAd?.kind, 'selected')
  if (productAd?.kind === 'selected') assert.equal(productAd.card.document.section, 'productos')
})

test('the agent retains course and product context and handles misspellings end to end', async () => {
  const keys = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'LLM_API_KEY', 'LLM_BASE_URL'] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.SUPABASE_URL = 'https://supabase.test'
  process.env.SUPABASE_SECRET_KEY = 'test-secret'
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon'
  process.env.LLM_API_KEY = 'test-llm'
  process.env.LLM_BASE_URL = 'https://model.test'
  const tenantId = `topic-${randomUUID()}`
  const storePath = path.resolve(process.cwd(), 'clientsdata', '_meta_store', `pos_${tenantId}.json`)
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === 'supabase.test') return Response.json([courses, products].map((doc) => ({
      id: doc.id, tenant_id: tenantId, title: doc.title, doc_type: 'markdown', is_active: true,
      updated_at: doc.updatedAt, content_markdown: doc.content,
    })))
    assert.equal(url.hostname, 'model.test')
    const body = JSON.parse(String(init?.body))
    requests.push(body.messages.map((message: { content: string }) => message.content).join('\n'))
    const responses = [
      '[NO_RESPONDER]',
      'Revofil cuesta $700 MXN.',
      JSON.stringify({ category: 'correct', reason: 'Precio documentado.' }),
      'Revofil cuesta $700 MXN.',
      JSON.stringify({ category: 'correct', reason: 'Precio documentado.' }),
    ]
    const answer = responses[requests.length - 1]
    assert.ok(answer)
    return Response.json({ choices: [{ message: { content: answer }, finish_reason: 'stop' }] })
  }
  try {
    const typo = await generateDbAgentAnswer({ tenantId, prompt: '', message: 'tienes curso de mesabotoz?', history: [] })
    assert.match(typo.answer, /Mesobotox/i)
    assert.match(typo.answer, /Técnica de rejuvenecimiento/)
    assert.equal(typo.autoEval.blocked, false)
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: 'tienes curso de mesabotoz?' },
      { role: 'assistant', content: 'Es una técnica de rejuvenecimiento.' },
      { role: 'user', content: 'qué descripción tiene el curso' },
      { role: 'assistant', content: 'Mejora el aspecto de la piel.' },
    ]
    const schedule = await generateDbAgentAnswer({ tenantId, prompt: '', message: 'que horario tiene el curso', history })
    assert.match(schedule.answer, /Mesobotox.*10:00 am a 2:00 pm/)
    const advertised = await generateDbAgentAnswer({
      tenantId, prompt: '', message: 'qué horario tiene el curso', history: [],
      referralContext: 'Anuncio: ID de anuncio 123 · anuncio Curso Mesobotox',
    })
    assert.match(advertised.answer, /Mesobotox.*10:00 am a 2:00 pm/)
    const product = await generateDbAgentAnswer({
      tenantId, prompt: '', message: 'cuánto cuesta el producto',
      history: [{ role: 'user', content: 'información producto Revofil' }, { role: 'assistant', content: 'Es un producto facial.' }],
    })
    assert.match(product.answer, /\$700/)
    assert.match(requests[1], /\[TEMA ACTUAL DE LA CONVERSACIÓN\][\s\S]*Revofil/)
    const productAd = await generateDbAgentAnswer({
      tenantId, prompt: '', message: 'precio', history: [],
      referralContext: 'Anuncio: ID de anuncio 123 · anuncio Producto Revofil',
    })
    assert.match(productAd.answer, /\$700/)
    assert.match(requests[3], /\[TEMA ACTUAL DE LA CONVERSACIÓN\][\s\S]*Revofil/)
    const ambiguous = await generateDbAgentAnswer({
      tenantId, prompt: '', message: 'cuanto cuesta', history: [{ role: 'user', content: 'Revofil y Peptonas' }],
    })
    assert.match(ambiguous.answer, /¿Te refieres a .*Revofil.*Peptonas/)
    assert.equal(ambiguous.autoEval.blocked, false)
    assert.equal(requests.length, 5)
  } finally {
    globalThis.fetch = originalFetch
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
  }
})
