import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { buildCourseDetailsFallback, generateDbAgentAnswer, resolveCourseDetailsFollowUp } from './dbChat.js'
import { createSearchIndex } from './searchIndex.js'
import type { WorkspaceDocument } from './workspace.js'

const content = `[FECHAS_CURSOS]
En línea:
24 Noviembre 2099 - Rejuvenecimiento facial en tercio inferior (Aplicación de toxina botulínica en tercio inferior)

[CURSO]
Nombre del curso: Toxina Botulínica: Tercio inferior.
Descripción: Técnica para bandas platismales y sonrisa gingival.
Precio: Online: $895 MXN

[CURSO]
Nombre del curso: Toxina Botulínica: Tercio superior.
Descripción: Técnica para arrugas del tercio superior.

[CURSO]
Nombre del curso: Microagujas
Precio: $400 MXN`

const doc: WorkspaceDocument = {
  id: 'courses', title: 'cursos.md', docType: 'cursos', section: 'cursos',
  isActive: true, updatedAt: '2026-01-01T00:00:00Z', content,
}
const index = createSearchIndex({ tenantId: 'follow-up', documents: [doc] })
const question = '¿qué cuenta ese curso? ¿qué temas lleva?'

test('a referential course question uses the last answer, not the broad earlier question', () => {
  const result = resolveCourseDetailsFollowUp(index, question, [
    { role: 'user', content: '¿Tienes curso rejuvenecimiento facial online?' },
    { role: 'assistant', content: 'El curso Toxina Botulínica: Tercio inferior cuesta $895 MXN.' },
  ])
  assert.equal(result?.kind, 'selected')
  if (result?.kind === 'selected') assert.match(result.card.body, /bandas platismales/)
})

test('calendar aliases identify the card and multiple courses require clarification', () => {
  const alias = resolveCourseDetailsFollowUp(index, question, [
    { role: 'assistant', content: 'Rejuvenecimiento facial en tercio inferior (Aplicación de toxina botulínica en tercio inferior).' },
  ])
  assert.equal(alias?.kind, 'selected')
  if (alias?.kind === 'selected') assert.match(alias.card.fields.name, /Tercio inferior/)
  const ambiguous = resolveCourseDetailsFollowUp(index, question, [
    { role: 'assistant', content: 'Tenemos Toxina Botulínica: Tercio inferior y Toxina Botulínica: Tercio superior.' },
  ])
  assert.equal(ambiguous?.kind, 'clarify')
  if (ambiguous?.kind === 'clarify') assert.equal(ambiguous.names.length, 2)
  assert.deepEqual(resolveCourseDetailsFollowUp(index, question, [{ role: 'assistant', content: 'Tenemos varios cursos.' }]), { kind: 'clarify', names: [] })
  assert.equal(resolveCourseDetailsFollowUp(index, 'temario de Microagujas', [{ role: 'assistant', content: 'Toxina Botulínica: Tercio inferior' }]), null)
  assert.equal(resolveCourseDetailsFollowUp(index, '¿qué temas lleva?', []), null)
})

test('fallback uses the course description or only a documented WhatsApp number', () => {
  const inferior = index.blocks.find((block) => /Tercio inferior/i.test(block.fields.name || ''))!
  const missing = index.blocks.find((block) => block.fields.name === 'Microagujas')!
  assert.match(buildCourseDetailsFallback(inferior, []), /bandas platismales/)
  assert.doesNotMatch(buildCourseDetailsFallback(missing, []), /WhatsApp|\d/)
  const profile = createSearchIndex({ tenantId: 'profile', documents: [{
    ...doc, id: 'general', title: 'infogeneral.md', section: 'general', docType: 'general',
    content: '[WHATSAPP_OFICIAL]\n+52 55 1234 5678',
  }] }).blocks
  assert.match(buildCourseDetailsFallback(missing, profile), /\+52 55 1234 5678/)
})

test('follow-up requests deliver the identified card to the model and judge; ambiguous replies ask first', async () => {
  const keys = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'LLM_API_KEY', 'LLM_BASE_URL'] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.SUPABASE_URL = 'https://supabase.test'
  process.env.SUPABASE_SECRET_KEY = 'test-secret'
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon'
  process.env.LLM_API_KEY = 'test-llm'
  process.env.LLM_BASE_URL = 'https://model.test'
  const tenantId = `follow-up-${randomUUID()}`
  const storePath = path.resolve(process.cwd(), 'clientsdata', '_meta_store', `pos_${tenantId}.json`)
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === 'supabase.test') return Response.json([
      { id: 'courses', tenant_id: tenantId, title: 'cursos.md', doc_type: 'markdown', is_active: true, updated_at: doc.updatedAt, content_markdown: content },
      { id: 'general', tenant_id: tenantId, title: 'infogeneral.md', doc_type: 'markdown', is_active: true, updated_at: doc.updatedAt, content_markdown: '[WHATSAPP_OFICIAL]\n+52 55 1234 5678' },
    ])
    assert.equal(url.hostname, 'model.test')
    const body = JSON.parse(String(init?.body))
    requests.push(body.messages.map((message: { content: string }) => message.content).join('\n'))
    const responses = [
      'La descripción aborda bandas platismales y sonrisa gingival.',
      JSON.stringify({ category: 'correct', reason: 'Respaldado por la ficha.' }),
      'No contamos con ese detalle. Consulta a un asesor por WhatsApp al +52 55 1234 5678.',
      JSON.stringify({ category: 'correct', reason: 'Derivación respaldada por el contacto.' }),
      '[NO_RESPONDER]',
      '[NO_RESPONDER]',
    ]
    const answer = responses[requests.length - 1]
    assert.ok(answer)
    return Response.json({ choices: [{ message: { content: answer }, finish_reason: 'stop' }] })
  }
  try {
    const result = await generateDbAgentAnswer({
      tenantId, prompt: '', message: question, history: [
        { role: 'user', content: '¿Tienes curso rejuvenecimiento facial online?' },
        { role: 'assistant', content: 'El curso Toxina Botulínica: Tercio inferior cuesta $895 MXN.' },
      ],
    })
    assert.equal(result.autoEval.blocked, false)
    assert.match(result.answer, /bandas platismales/)
    assert.match(requests[0], /\[SEGUIMIENTO DE CURSO\][\s\S]*Descripción: Técnica para bandas platismales/)
    assert.match(requests[1], /Excepción para \[SEGUIMIENTO DE CURSO\]/)
    assert.match(requests[1], /\[SEGUIMIENTO DE CURSO\]/)
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath)

    const missing = await generateDbAgentAnswer({
      tenantId, prompt: '', message: question,
      history: [{ role: 'assistant', content: 'Tenemos el curso Microagujas.' }],
    })
    assert.equal(missing.autoEval.blocked, false)
    assert.match(missing.answer, /WhatsApp/)
    assert.match(requests[2], /Si no existe descripción ni temario/)
    assert.match(requests[2], /\+52 55 1234 5678/)
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath)

    const recovered = await generateDbAgentAnswer({
      tenantId, prompt: '', message: question,
      history: [{ role: 'assistant', content: 'El curso Toxina Botulínica: Tercio inferior cuesta $895 MXN.' }],
    })
    assert.equal(recovered.autoEval.blocked, false)
    assert.match(recovered.answer, /bandas platismales/)
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
    const recoveredMissing = await generateDbAgentAnswer({
      tenantId, prompt: '', message: question,
      history: [{ role: 'assistant', content: 'Tenemos el curso Microagujas.' }],
    })
    assert.equal(recoveredMissing.autoEval.blocked, false)
    assert.match(recoveredMissing.answer, /\+52 55 1234 5678/)
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath)

    const ambiguous = await generateDbAgentAnswer({
      tenantId, prompt: '', message: question, history: [
        { role: 'assistant', content: 'Tenemos Toxina Botulínica: Tercio inferior y Toxina Botulínica: Tercio superior.' },
      ],
    })
    assert.equal(requests.length, 6)
    assert.equal(ambiguous.autoEval.blocked, false)
    assert.match(ambiguous.answer, /¿Te refieres al curso/)
    assert.match(ambiguous.answer, /Tercio inferior/)
    assert.match(ambiguous.answer, /Tercio superior/)
  } finally {
    globalThis.fetch = originalFetch
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
    if (fs.existsSync(`${storePath}.tmp`)) fs.unlinkSync(`${storePath}.tmp`)
  }
})
