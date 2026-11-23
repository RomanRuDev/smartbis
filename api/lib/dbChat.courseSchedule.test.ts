import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { buildDbDocumentsContextBlock, findAskedCourseSchedule, generateDbAgentAnswer } from './dbChat.js'
import { createSearchIndex } from './searchIndex.js'
import type { WorkspaceDocument } from './workspace.js'

const content = `[FECHAS_CURSOS]
En línea:
25 Noviembre 2099 - Lipoenzimas
Presencial:
Sin cursos presenciales por el momento.

[CURSO]
Nombre del curso: Lipoenzimas.
Descripción: Aplicación de enzimas lipolíticas.
Modalidades: Online, Presencial
Precio: Online: $595 MXN / Presencial: $1350 MXN
Horario: 1:00 pm a 5:00 pm (Hora local de Hermosillo, Sonora)

[CURSO]
Nombre del curso: Peptonas y Lipoenzimas.
Precio: $400 MXN
Horario: 9:00 am a 6:00 pm.

[CURSO]
Nombre del curso: Microrellenos.
Precio: $500 MXN`

const document: WorkspaceDocument = {
  id: 'courses', title: 'cursos.md', docType: 'cursos', section: 'cursos',
  isActive: true, updatedAt: '2026-01-01T00:00:00Z', content,
}

test('the requested course schedule is retrieved from its card without losing catalog classification', () => {
  const index = createSearchIndex({ tenantId: 'schedule', documents: [document] })
  const question = 'Cual es el horario del curso del lipoenzimas'
  const result = buildDbDocumentsContextBlock(index, question, false, new Date('2026-11-21T12:00:00Z'))
  assert.equal(result.askedSchedule?.schedule, '1:00 pm a 5:00 pm (Hora local de Hermosillo, Sonora)')
  assert.match(result.contextBlock, /\[HORARIO DEL CURSO PREGUNTADO\][\s\S]*1:00 pm a 5:00 pm/)
  assert.ok(result.matchedBlocks.some((block) => block.body.includes('Horario: 1:00 pm')))
  assert.equal(index.blocks.find((block) => block.fields.name === 'Lipoenzimas.')?.kind, 'catalog_item')
  assert.equal(findAskedCourseSchedule(index.blocks, 'horario de curso Microrellenos'), null)
  assert.equal(findAskedCourseSchedule(index.blocks, 'horario de producto Lipoenzimas'), null)
  assert.equal(findAskedCourseSchedule(index.blocks, 'horario de Lipoenzimas y Peptonas y Lipoenzimas'), null)
})

test('the repository schedule list resolves Lipoenzimas without using the combination course', () => {
  const localContent = fs.readFileSync(path.resolve(process.cwd(), 'content', 'cursos.md'), 'utf8')
  const index = createSearchIndex({ tenantId: 'repository-schedule', documents: [{ ...document, content: localContent }] })
  assert.equal(findAskedCourseSchedule(index.blocks, 'horario del curso de Lipoenzimas')?.schedule, '10:00 AM - 2:00 PM')
})

test('a separate schedule list requires an exact and unambiguous course name', () => {
  const index = createSearchIndex({ tenantId: 'schedule-list', documents: [{ ...document, content: `[HORARIOS]
10:00 AM - 2:00 PM
- Lipoenzimas
9:00 AM - 6:00 PM
- Peptonas y Lipoenzimas

[CURSO]
Nombre del curso: Lipoenzimas.

[CURSO]
Nombre del curso: Peptonas y Lipoenzimas.` }] })
  assert.equal(findAskedCourseSchedule(index.blocks, 'horario del curso Lipoenzimas')?.schedule, '10:00 AM - 2:00 PM')
  assert.equal(findAskedCourseSchedule(index.blocks, 'horario del curso Peptonas y Lipoenzimas')?.schedule, '9:00 AM - 6:00 PM')
  const conflicting = createSearchIndex({ tenantId: 'ambiguous', documents: [{ ...document, content: `[HORARIOS]
10:00 AM - 2:00 PM
- Lipoenzimas
9:00 AM - 6:00 PM
- Lipoenzimas

[CURSO]
Nombre del curso: Lipoenzimas.` }] })
  assert.equal(findAskedCourseSchedule(conflicting.blocks, 'horario de Lipoenzimas'), null)
})

test('only a future date for the same course is offered as a modality alternative', () => {
  const now = new Date('2026-11-21T12:00:00Z')
  const context = (calendar: string, question: string) => {
    const index = createSearchIndex({ tenantId: 'alternatives', documents: [{ ...document, content: `[FECHAS_CURSOS]
${calendar}

[CURSO]
Nombre del curso: Lipoenzimas.
[CURSO]
Nombre del curso: Peptonas y Lipoenzimas.` }] })
    return buildDbDocumentsContextBlock(index, question, false, now)
  }
  const question = 'tienes curso de lipoenzimas presencial?'
  const available = context('En línea:\n25 Noviembre 2026 - Lipoenzimas\nPresencial:\nSin cursos presenciales por el momento.', question)
  assert.match(String(available.explicitUnavailableReply), /no hay cursos presenciales/)
  assert.match(String(available.explicitUnavailableReply), /Lipoenzimas sí está programado en línea para el 25 de noviembre de 2026/)
  const past = context('En línea:\n20 Noviembre 2026 - Lipoenzimas\nPresencial:\nSin cursos presenciales por el momento.', question)
  assert.doesNotMatch(String(past.explicitUnavailableReply), /sí está programado/)
  const different = context('En línea:\n25 Noviembre 2026 - Peptonas y Lipoenzimas\nPresencial:\nSin cursos presenciales por el momento.', question)
  assert.doesNotMatch(String(different.explicitUnavailableReply), /sí está programado/)
  const reverse = context('En línea:\nSin cursos en línea por el momento.\nPresencial:\n25 Noviembre 2026 - Lipoenzimas', 'tienes curso de lipoenzimas online?')
  assert.match(String(reverse.explicitUnavailableReply), /Lipoenzimas sí está programado presencial para el 25 de noviembre de 2026/)
  const both = context('En línea:\n25 Noviembre 2026 - Lipoenzimas\nPresencial:\n26 Noviembre 2026 - Lipoenzimas', question)
  assert.equal(both.explicitUnavailableReply, null)
})

test('schedule-only responses use the documented time even when a modality has no dates', async () => {
  const keys = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'LLM_API_KEY', 'LLM_BASE_URL'] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.SUPABASE_URL = 'https://supabase.test'
  process.env.SUPABASE_SECRET_KEY = 'test-secret'
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon'
  process.env.LLM_API_KEY = 'test-llm'
  process.env.LLM_BASE_URL = 'https://model.test'
  const tenantId = `schedule-${randomUUID()}`
  const storePath = path.resolve(process.cwd(), 'clientsdata', '_meta_store', `pos_${tenantId}.json`)
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  let activeContent = content
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === 'supabase.test') {
      return Response.json([{ id: 'courses', tenant_id: tenantId, title: 'cursos.md', doc_type: 'markdown', is_active: true, updated_at: document.updatedAt, content_markdown: activeContent }])
    }
    assert.equal(url.hostname, 'model.test')
    const body = JSON.parse(String(init?.body))
    requests.push(body.messages.map((message: { content: string }) => message.content).join('\n'))
    const answers = [
      'El curso Lipoenzimas online cuesta $595 MXN.',
      JSON.stringify({ category: 'correct', reason: 'Horario y precio documentados.' }),
      'Por el momento no hay cursos presenciales. El precio presencial es $1350 MXN.',
      JSON.stringify({ category: 'correct', reason: 'Disponibilidad, precio y alternativa documentados.' }),
    ]
    const answer = answers[requests.length - 1]
    assert.ok(answer)
    return Response.json({ choices: [{ message: { content: answer }, finish_reason: 'stop' }] })
  }
  try {
    const result = await generateDbAgentAnswer({
      tenantId, prompt: '', message: 'Cual es el horario del curso del lipoenzimas', history: [],
    })
    assert.match(result.answer, /1:00 pm a 5:00 pm \(Hora local de Hermosillo, Sonora\)/)
    assert.doesNotMatch(result.answer, /\$1350|9:00 am/)
    assert.equal(result.autoEval.blocked, false)
    const availability = await generateDbAgentAnswer({
      tenantId, prompt: '', message: 'tienes curso de lipoenzimas presencial?', history: [],
    })
    assert.match(availability.answer, /no hay cursos presenciales/i)
    assert.match(availability.answer, /Lipoenzimas sí está programado en línea para el 25 de noviembre de 2099/)
    const presencial = await generateDbAgentAnswer({
      tenantId, prompt: '', message: 'horario del curso Lipoenzimas presencial', history: [],
    })
    assert.match(presencial.answer, /no hay cursos presenciales/i)
    assert.match(presencial.answer, /1:00 pm a 5:00 pm/)
    assert.match(presencial.answer, /en línea para el 25 de noviembre de 2099/)
    const mixed = await generateDbAgentAnswer({
      tenantId, prompt: '', message: 'horario y precio del curso Lipoenzimas online', history: [],
    })
    assert.match(mixed.answer, /1:00 pm a 5:00 pm/)
    assert.match(mixed.answer, /\$595/)
    assert.match(requests[0], /\[HORARIO DEL CURSO PREGUNTADO\]/)
    assert.match(requests[1], /\[HORARIO DEL CURSO PREGUNTADO\]/)
    assert.match(requests[1], /El horario del curso Lipoenzimas/)
    assert.equal(mixed.autoEval.blocked, false)
    activeContent = content.replace('1:00 pm a 5:00 pm', '2:00 pm a 6:00 pm')
    const updated = await generateDbAgentAnswer({
      tenantId, prompt: '', message: 'horario del curso de lipoenzimas', history: [
        { role: 'assistant', content: '¿Te interesa la modalidad online?' },
      ],
    })
    assert.match(updated.answer, /2:00 pm a 6:00 pm/)
    assert.doesNotMatch(updated.answer, /1:00 pm a 5:00 pm/)
    assert.equal(requests.length, 2)
    const mixedAvailability = await generateDbAgentAnswer({
      tenantId, prompt: '', message: 'cuál es el precio del curso Lipoenzimas presencial?', history: [],
    })
    assert.match(mixedAvailability.answer, /\$1350/)
    assert.match(mixedAvailability.answer, /Lipoenzimas sí está programado en línea para el 25 de noviembre de 2099/)
    assert.match(requests[2], /\[ALTERNATIVA DEL MISMO CURSO\]/)
    assert.match(requests[3], /\[ALTERNATIVA DEL MISMO CURSO\]/)
    assert.equal(mixedAvailability.autoEval.blocked, false)
  } finally {
    globalThis.fetch = originalFetch
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
  }
})
