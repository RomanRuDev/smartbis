import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { applyUpcomingCourseDateCorrection, buildCourseListReply, buildDbDocumentsContextBlock, findUnavailableCourseModalities, generateDbAgentAnswer } from './dbChat.js'
import { createSearchIndex } from './searchIndex.js'
import type { WorkspaceDocument } from './workspace.js'

const NOW = new Date('2026-11-17T12:00:00Z')

function courses(calendar: string): WorkspaceDocument {
  return {
    id: 'courses',
    title: 'cursos.md',
    docType: 'cursos',
    section: 'cursos',
    isActive: true,
    updatedAt: '2026-01-01T00:00:00Z',
    content: `[CURSO]\nNombre del curso: Mesobotox\nPrecio: $500\n\n${calendar}`,
  }
}

const ONLINE = 'En línea tenemos tentativamente programados:\n✨ 02 Diciembre - Mesobotox'

test('a modality section replaced by a "no courses" text is unavailable', () => {
  const index = createSearchIndex({
    tenantId: 't1',
    documents: [courses(`[FECHAS_CURSOS]\n${ONLINE}\n\nPresencial tenemos programados: Sin cursos presenciales por el momento.`)],
  })
  assert.deepEqual(findUnavailableCourseModalities(index.blocks, NOW), ['presencial'])

  const context = buildDbDocumentsContextBlock(index, '¿Tienen cursos presenciales?', false, NOW).contextBlock
  assert.match(context, /\[MODALIDADES SIN CURSOS\]/)
  assert.match(context, /no hay cursos presenciales/)
})

test('a modality with dates is available and the list reply states the missing one', () => {
  const withDates = createSearchIndex({
    tenantId: 't2',
    documents: [courses(`[FECHAS_CURSOS]\n${ONLINE}\n\nPresencial tenemos programados:\n✨ 03 Diciembre - Mesobotox`)],
  })
  assert.deepEqual(findUnavailableCourseModalities(withDates.blocks, NOW), [])

  const withoutPresential = createSearchIndex({
    tenantId: 't3',
    documents: [courses(`[FECHAS_CURSOS]\n${ONLINE}\n\nPresencial tenemos programados:\nSin cursos presenciales por el momento.`)],
  })
  const reply = buildCourseListReply('cursos', '', withoutPresential.blocks, NOW)
  assert.match(String(reply), /Por el momento no hay cursos presenciales/)
  assert.doesNotMatch(buildDbDocumentsContextBlock(withDates, '¿Tienen cursos presenciales?', false, NOW).contextBlock, /MODALIDADES SIN CURSOS/)
})

test('course details and the judge receive the unavailable-modality rule without removing the online offer', () => {
  const content = `[FECHAS_CURSOS]
En línea tenemos tentativamente programados:
25 Noviembre - Lipoenzimas
Presencial tenemos programados:
Sin cursos presenciales por el momento.

[CURSO]
Nombre del curso: Lipoenzimas
Descripción: Aprendizaje de la técnica.
Modalidades: Online, Presencial
Precio: Online: $595 MXN / Presencial: $1350 MXN
Incluye:
Online: Manual digital.
Presencial: Constancia y materiales.`
  const index = createSearchIndex({ tenantId: 'modality', documents: [{ ...courses(''), content }] })
  for (const question of ['Más información curso online lipoenzimas', '¿Cuánto cuesta lipoenzimas presencial?', 'lipoenzimas']) {
    const result = buildDbDocumentsContextBlock(index, question, false, NOW)
    assert.match(result.contextBlock, /25 de noviembre de 2026 \(en línea\)/)
    assert.match(result.contextBlock, /por el momento no hay cursos presenciales/)
    assert.match(result.unavailableModalitiesBlock, /No ofrezcas esas modalidades ni menciones sus precios o beneficios/)
  }
  const answer = 'El curso de Lipoenzimas cuesta $595 MXN en línea el 25 de noviembre de 2026. No hay cursos presenciales por el momento.'
  for (const question of ['Más información curso online lipoenzimas', 'Más información curso lipoenzimas']) {
    assert.equal(applyUpcomingCourseDateCorrection(answer, question, index.blocks, NOW, 'America/Hermosillo'), answer)
  }
})

test('a course without dates in one modality is not offered in that modality even when others have dates', () => {
  const index = createSearchIndex({
    tenantId: 'per-course',
    documents: [{ ...courses(''), content: `[FECHAS_CURSOS]
En línea:
25 Noviembre - Lipoenzimas
Presencial:
26 Noviembre - Otro curso

[CURSO]
Nombre del curso: Lipoenzimas
Precio: Online: $595 MXN / Presencial: $1350 MXN` }],
  })
  for (const question of ['Más información curso online lipoenzimas', '¿Cuál es el precio presencial de lipoenzimas?']) {
    const result = buildDbDocumentsContextBlock(index, question, false, NOW)
    assert.equal(result.unavailableModalitiesBlock, '')
    assert.match(result.courseAvailabilityBlock, /Lipoenzimas no hay fecha vigente en presencial/)
    assert.match(result.courseAvailabilityBlock, /aunque los soliciten/)
    assert.match(result.contextBlock, /\$1350/)
  }
  const noCalendar = createSearchIndex({ tenantId: 'no-calendar', documents: [courses('')] })
  assert.equal(buildDbDocumentsContextBlock(noCalendar, 'precio presencial mesobotox', false, NOW).courseAvailabilityBlock, '')
  const noCourseDate = createSearchIndex({
    tenantId: 'no-course-date',
    documents: [courses('[FECHAS_CURSOS]\nEn línea:\n25 Noviembre - Otro curso')],
  })
  const noDateResult = buildDbDocumentsContextBlock(noCourseDate, 'precio curso presencial mesobotox', false, NOW)
  assert.match(noDateResult.courseAvailabilityBlock, /Mesobotox no hay fecha vigente en presencial ni en línea/)
  assert.match(noDateResult.contextBlock, /25 Noviembre - Otro curso/)
  const both = createSearchIndex({
    tenantId: 'both-dates',
    documents: [courses(`[FECHAS_CURSOS]\n${ONLINE}\nPresencial:\n03 Diciembre - Mesobotox`)],
  })
  assert.equal(buildDbDocumentsContextBlock(both, 'precio curso presencial mesobotox', false, NOW).courseAvailabilityBlock, '')
  const onlineMissing = createSearchIndex({
    tenantId: 'online-missing',
    documents: [courses('[FECHAS_CURSOS]\nEn línea:\nSin cursos en línea por el momento.\nPresencial:\n03 Diciembre - Mesobotox')],
  })
  const onlineResult = buildDbDocumentsContextBlock(onlineMissing, 'precio curso en línea mesobotox', false, NOW)
  assert.match(onlineResult.unavailableModalitiesBlock, /no hay cursos en línea/)
  assert.match(onlineResult.unavailableModalitiesBlock, /aunque los soliciten/)
})

test('an absent date alone and a positive statement do not declare a modality unavailable', () => {
  const withoutNotice = createSearchIndex({
    tenantId: 'missing-date',
    documents: [courses(`[FECHAS_CURSOS]\n${ONLINE}\nPresencial tenemos programados:`)],
  })
  assert.deepEqual(findUnavailableCourseModalities(withoutNotice.blocks, NOW), [])
  const positive = createSearchIndex({
    tenantId: 'positive',
    documents: [courses(`[FECHAS_CURSOS]\n${ONLINE}\nPresencial tenemos cursos por el momento.`)],
  })
  assert.deepEqual(findUnavailableCourseModalities(positive.blocks, NOW), [])
})

test('model and judge reject unavailable offers and explicit price requests receive an availability notice', async () => {
  const keys = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'LLM_API_KEY', 'LLM_BASE_URL'] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.SUPABASE_URL = 'https://supabase.test'
  process.env.SUPABASE_SECRET_KEY = 'test-secret'
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon'
  process.env.LLM_API_KEY = 'test-llm'
  process.env.LLM_BASE_URL = 'https://model.test'
  const tenantId = `availability-${randomUUID()}`
  const storePath = path.resolve(process.cwd(), 'clientsdata', '_meta_store', `pos_${tenantId}.json`)
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === 'supabase.test') {
      return Response.json([{
        id: 'courses', tenant_id: tenantId, title: 'cursos.md', doc_type: 'markdown', is_active: true,
        updated_at: '2026-01-01T00:00:00Z',
        content_markdown: `[FECHAS_CURSOS]
En línea:
25 Noviembre 2099 - Lipoenzimas
Presencial:
Sin cursos presenciales por el momento.

[CURSO]
Nombre del curso: Lipoenzimas
Descripción: Aprendizaje de la técnica.
Modalidades: Online, Presencial
Precio: Online: $595 MXN / Presencial: $1350 MXN`,
      }])
    }
    assert.equal(url.hostname, 'model.test')
    const body = JSON.parse(String(init?.body))
    requests.push(body.messages.map((message: { content: string }) => message.content).join('\n'))
    const answers = [
      'El curso online cuesta $595 MXN. El curso presencial cuesta $1350 MXN.',
      JSON.stringify({ category: 'error', reason: 'Se ofreció un precio de una modalidad sin cursos.' }),
      'El curso online cuesta $595 MXN y es el 25 de noviembre de 2099. Por el momento no hay cursos presenciales.',
      JSON.stringify({ category: 'correct', reason: 'La información respeta el calendario.' }),
    ]
    const answer = answers[requests.length - 1]
    assert.ok(answer)
    return Response.json({ choices: [{ message: { content: answer }, finish_reason: 'stop' }] })
  }
  try {
    const result = await generateDbAgentAnswer({
      tenantId, prompt: '', message: 'Más información curso online lipoenzimas', history: [],
    })
    assert.equal(requests.length, 2)
    assert.match(requests[0], /no hay cursos presenciales/)
    assert.match(requests[0], /No ofrezcas esas modalidades ni menciones sus precios/)
    assert.match(requests[1], /\[MODALIDADES SIN CURSOS\]/)
    assert.match(requests[1], /es un error ofrecerla o dar su precio o beneficios/)
    assert.equal(result.autoEval.category, 'error')
    assert.equal(result.autoEval.blocked, true)
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
    const safeResult = await generateDbAgentAnswer({
      tenantId, prompt: '', message: 'Más información curso online lipoenzimas', history: [],
    })
    assert.equal(requests.length, 4)
    assert.equal(safeResult.autoEval.blocked, false)
    assert.match(safeResult.answer, /\$595 MXN/)
    assert.match(safeResult.answer, /no hay cursos presenciales/)
    assert.doesNotMatch(safeResult.answer, /1350/)
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
    const requestedResult = await generateDbAgentAnswer({
      tenantId, prompt: '', message: '¿Cuál es el precio presencial del curso de lipoenzimas?', history: [],
    })
    assert.equal(requests.length, 4)
    assert.equal(requestedResult.autoEval.blocked, false)
    assert.match(requestedResult.answer, /^Por el momento no hay cursos presenciales/)
    assert.doesNotMatch(requestedResult.answer, /1350/)
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
