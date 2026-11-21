import assert from 'node:assert/strict'
import test from 'node:test'
import { createSearchIndex } from './searchIndex.js'
import { applyUpcomingCourseDateCorrection, buildAskedCourseDatesBlock, buildDbDocumentsContextBlock, findAskedCourseDates, generateDbAgentAnswer, getUpcomingCourseDates } from './dbChat.js'

// The calendar as the business writes it: no year, "✨", leading zeros
const calendar = `[FECHAS_CURSOS]
En línea tenemos tentativamente programados:
✨ 11 Noviembre - Peeling químico
✨ 24 Noviembre - Rejuvenecimiento facial en tercio inferior (Botox inferior)
✨ 02 Diciembre - Mesobotox
✨ 09 Diciembre - Eliminación de verrugas y manchas con Plasma Pen
✨ 16 Diciembre - Aumento de glúteos con Peptonas
✨ 13 Enero 2027 - Hidrofacial

Presencial tenemos programados:
✨ 05 Noviembre - Rejuvenecimiento y eliminación de manchas con Dermapen
✨ 12 Noviembre - Eliminación de verrugas y manchas con plasma Pen
✨ 19 Noviembre - Limpieza facial
✨ 10 Diciembre - Relleno de labios con Hyaluron Pen

[CURSO]
Nombre del curso: Eliminación de verrugas y manchas con Fibroblast.
Precio: Online: $595 MXN
`

const blocks = createSearchIndex({
  tenantId: 't',
  documents: [{ id: 'd1', title: 'cursos.md', docType: 'cursos', section: 'cursos', isActive: true, updatedAt: '2026-11-01T00:00:00.000Z', content: calendar }],
}).blocks
const now = new Date('2026-11-04T18:00:00Z')
const zone = 'America/Hermosillo'
const describe = (question: string, at = now) =>
  getUpcomingCourseDates(question, blocks, at, zone).map((date) => `${date.year}-${date.month}-${date.day} ${date.modality} ${date.courseName}`).sort()

test('a question about warts and spots finds both calendar dates, whatever the course card is called', () => {
  assert.deepEqual(describe('tienes cursos de verrugas y manchas?'), [
    '2026-11-12 presencial Eliminación de verrugas y manchas con plasma Pen',
    '2026-12-9 en línea Eliminación de verrugas y manchas con Plasma Pen',
  ])
  assert.equal(describe('cursos de verrugas').length, 2)
  assert.equal(describe('cuándo es el curso de eliminación de verrugas con plasma pen').length, 2)
})

test('a calendar date without a year is of the current year; a written year is kept', () => {
  assert.deepEqual(describe('hay curso de mesobotox?'), ['2026-12-2 en línea Mesobotox'])
  assert.deepEqual(describe('fechas de hidrofacial'), ['2027-1-13 en línea Hidrofacial'])
})

test('dates that already passed are left out', () => {
  assert.deepEqual(describe('tienes cursos de verrugas y manchas?', new Date('2026-11-20T18:00:00Z')), [
    '2026-12-9 en línea Eliminación de verrugas y manchas con Plasma Pen',
  ])
})

test('a broad course question prioritizes the nearest matching course in the requested modality', () => {
  const content = `[FECHAS_CURSOS]
En línea:
24 Noviembre - Toxina botulínica inferior
20 Noviembre - Toxina botulínica superior
10 Noviembre - Botox anterior
Presencial:
22 Noviembre - Botox cuello

[CURSO]
Nombre del curso: Toxina botulínica inferior
Descripción: Información inferior

[CURSO]
Nombre del curso: Toxina botulínica superior
Descripción: Información superior

[CURSO]
Nombre del curso: Botox cuello
Descripción: Información cuello`
  const index = createSearchIndex({
    tenantId: 'earliest',
    documents: [{ id: 'courses', title: 'cursos.md', docType: 'cursos', section: 'cursos', isActive: true, updatedAt: '2026-01-01T00:00:00Z', content }],
  })
  const today = new Date('2026-11-17T18:00:00Z')
  const result = buildDbDocumentsContextBlock(index, '¿Tienen curso de Botox?', false, today)
  assert.match(result.priorityCourseBlock, /prioriza la ficha y los detalles de Toxina botulínica superior/)
  assert.match(result.askedDatesBlock, /20 de noviembre de 2026 \(en línea\): Toxina botulínica superior/)
  assert.match(result.askedDatesBlock, /22 de noviembre de 2026 \(presencial\): Botox cuello/)
  assert.match(result.askedDatesBlock, /24 de noviembre de 2026 \(en línea\): Toxina botulínica inferior/)
  assert.doesNotMatch(result.askedDatesBlock, /Botox anterior/)
  const online = buildDbDocumentsContextBlock(index, 'curso online de Botox', false, today)
  assert.match(online.priorityCourseBlock, /detalles de Toxina botulínica superior/)
  const inPerson = buildDbDocumentsContextBlock(index, 'curso presencial de Botox', false, today)
  assert.equal(inPerson.priorityCourseBlock, '')
  assert.match(inPerson.askedDatesBlock, /22 de noviembre de 2026 \(presencial\): Botox cuello/)
  const specific = buildDbDocumentsContextBlock(index, 'curso toxina botulínica inferior online', false, today)
  assert.equal(specific.priorityCourseBlock, '')
})

test('other courses do not match', () => {
  assert.deepEqual(describe('curso de glúteos'), ['2026-12-16 en línea Aumento de glúteos con Peptonas'])
  assert.deepEqual(describe('tienes cursos de verrugas y manchas?').filter((line) => /Dermapen|labios/.test(line)), [])
  assert.deepEqual(describe('cursos de microblading'), [])
  assert.deepEqual(describe('tienes cursos?'), [])
})

test('the asked-dates block lists each date with its year, modality and calendar name', () => {
  const block = buildAskedCourseDatesBlock(findAskedCourseDates('tienes cursos de verrugas y manchas?', blocks, now, zone))
  assert.match(block, /^\[FECHAS DEL CURSO PREGUNTADO\]/)
  assert.match(block, /- 12 de noviembre de 2026 \(presencial\): Eliminación de verrugas y manchas con plasma Pen\n- 9 de diciembre de 2026 \(en línea\): Eliminación de verrugas y manchas con Plasma Pen$/)
  assert.equal(buildAskedCourseDatesBlock(findAskedCourseDates('cursos de microblading', blocks, now, zone)), '')
})

test('a calendar course without a card of its own name is marked as such', () => {
  const dates = findAskedCourseDates('tienes cursos de verrugas y manchas?', blocks, now, zone)
  const block = buildAskedCourseDatesBlock(dates, ['Eliminación de verrugas y manchas con Fibroblast.'])
  assert.equal(block.match(/sin ficha \[CURSO\] con este nombre/g)?.length, 2)
  const withCard = buildAskedCourseDatesBlock(dates, ['Eliminación de verrugas y manchas con Plasma Pen.'])
  assert.doesNotMatch(withCard, /sin ficha/)
})

test('a calendar name links the unique card contained in it, without confusing superior and inferior', () => {
  const content = `[FECHAS_CURSOS]
En línea:
24 Noviembre - Rejuvenecimiento facial en tercio inferior (Aplicación de toxina botulínica en tercio inferior)

[CURSO]
Nombre del curso: Toxina Botulínica: Tercio inferior.
Descripción: Curso inferior.
Precio: $895 MXN ($48 USD)

[CURSO]
Nombre del curso: Toxina Botulínica: Tercio superior.
Descripción: Curso superior.
Precio: $500 MXN`
  const index = createSearchIndex({
    tenantId: 'referral-course',
    documents: [{ id: 'courses', title: 'cursos.md', docType: 'cursos', section: 'cursos', isActive: true, updatedAt: '2026-01-01T00:00:00Z', content }],
  })
  const question = 'Más información Rejuvenecimiento facial tercio inferior'
  const result = buildDbDocumentsContextBlock(index, question, false, now)
  assert.match(result.contextBlock, /ficha correspondiente: Toxina Botulínica: Tercio inferior/)
  assert.match(result.contextBlock, /Descripción: Curso inferior/)
  assert.match(result.contextBlock, /24 de noviembre de 2026 \(en línea\)/)
  assert.doesNotMatch(result.contextBlock, /sin ficha \[CURSO\] con este nombre/)
  assert.ok(result.matchedBlocks.some((block) => block.fields.name === 'Toxina Botulínica: Tercio inferior.'))
  assert.deepEqual(findAskedCourseDates('Más información curso rejuvenecimiento facial tercio superior', index.blocks, now, zone).matches, [])
  assert.doesNotMatch(
    applyUpcomingCourseDateCorrection('El curso de tercio superior no tiene fecha programada.', 'curso rejuvenecimiento facial tercio superior', index.blocks, now, zone),
    /24 de noviembre/,
  )
})

test('a similar card is not linked when multiple cards match or a distinctive word differs', () => {
  const dates = findAskedCourseDates('curso de verrugas y manchas', blocks, now, zone)
  const ambiguous = buildAskedCourseDatesBlock(dates, [
    'Verrugas y manchas con Plasma Pen',
    'Eliminación de verrugas y manchas con Plasma Pen',
  ])
  assert.doesNotMatch(ambiguous, /ficha correspondiente:/)
  const different = buildAskedCourseDatesBlock(dates, ['Eliminación de verrugas y manchas con Fibroblast'])
  assert.doesNotMatch(different, /ficha correspondiente:/)
})

test('ad trigger and a brief follow-up deliver the calendar and linked card to the model and judge', async () => {
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
      return Response.json([{
        id: 'courses', tenant_id: 'ad-course-test', title: 'cursos.md', doc_type: 'markdown', is_active: true,
        updated_at: '2026-01-01T00:00:00Z',
        content_markdown: `[FECHAS_CURSOS]
En línea:
24 Noviembre 2099 - Rejuvenecimiento facial en tercio inferior (Aplicación de toxina botulínica en tercio inferior)

[CURSO]
Nombre del curso: Toxina Botulínica: Tercio inferior.
Descripción: Técnica para tercio inferior.
Precio: Online: $895 MXN ($48 USD)

[CURSO]
Nombre del curso: Toxina Botulínica: Tercio superior.
Descripción: Técnica para tercio superior.
Precio: Online: $500 MXN`,
      }])
    }
    assert.equal(url.hostname, 'model.test')
    const body = JSON.parse(String(init?.body))
    requests.push(body.messages.map((message: { content: string }) => message.content).join('\n'))
    const answer = requests.length % 2 === 1
      ? 'El curso de Toxina Botulínica: Tercio inferior cuesta $895 MXN y es en línea el 24 de noviembre de 2099.'
      : JSON.stringify({ category: 'correct', reason: 'Respaldado por los documentos.' })
    return Response.json({ choices: [{ message: { content: answer }, finish_reason: 'stop' }] })
  }
  try {
    const referralContext = 'El cliente llegó desde este anuncio: ID de anuncio 123 · anuncio CURSO DE REJUVENECIMIENTO FACIAL TERCIO INFERIOR'
    for (const message of ['Más información Rejuvenecimiento facial tercio inferior', 'precio']) {
      const start = requests.length
      await generateDbAgentAnswer({ tenantId: 'ad-course-test', prompt: '', message, history: [], referralContext })
      assert.equal(requests.length, start + 2)
      assert.match(requests[start], /ficha correspondiente: Toxina Botulínica: Tercio inferior/)
      assert.match(requests[start], /Técnica para tercio inferior/)
      assert.match(requests[start + 1], /Técnica para tercio inferior/)
      assert.match(requests[start + 1], /ficha correspondiente: Toxina Botulínica: Tercio inferior/)
    }
  } finally {
    globalThis.fetch = originalFetch
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
})

test('an answer that already gives the right dates is left as written', () => {
  const answer = [
    'Tenemos estos cursos:',
    '',
    '**1. Eliminación de verrugas y manchas con Plasma Pen**',
    '- En línea: 9 de diciembre de 2026',
    '- Presencial: 12 de noviembre de 2026',
    '',
    '¿Te interesa alguno?',
  ].join('\n')
  assert.equal(applyUpcomingCourseDateCorrection(answer, 'tienes cursos de verrugas y manchas?', blocks, now, zone), answer)
})

test('adding a missing date does not erase a numbered course with an already stated date and details', () => {
  const answer = [
    'Tenemos dos cursos:',
    '',
    '**1. Eliminación de verrugas y manchas con Plasma Pen**',
    'Fecha: 9 de diciembre de 2026 (en línea)',
    'Precio: $595 MXN. Incluye práctica.',
    '',
    '**2. Eliminación de verrugas y manchas con plasma Pen**',
    'Modalidad presencial. Incluye materiales.',
    '',
    '¿Te interesa alguno?',
  ].join('\n')
  const result = applyUpcomingCourseDateCorrection(answer, 'tienes cursos de verrugas y manchas?', blocks, now, zone)
  assert.match(result, /\*\*1\. Eliminación de verrugas y manchas con Plasma Pen\*\*/)
  assert.match(result, /Fecha: 9 de diciembre de 2026 \(en línea\)/)
  assert.match(result, /Precio: \$595 MXN\. Incluye práctica\./)
  assert.match(result, /\*\*2\. Eliminación de verrugas y manchas con plasma Pen\*\*/)
  assert.match(result, /Modalidad presencial\. Incluye materiales\./)
  assert.match(result, /12 de noviembre de 2026 \(presencial\)/)
  assert.equal((result.match(/9 de diciembre de 2026/g) || []).length, 1)
})

test('a broad Botox answer preserves both numbered courses when a date is added', () => {
  const content = `[FECHAS_CURSOS]
En línea:
20 Noviembre - Toxina botulínica tercio superior
24 Noviembre - Rejuvenecimiento facial tercio inferior (Botox inferior)`
  const index = createSearchIndex({
    tenantId: 'numbered-botox',
    documents: [{ id: 'courses', title: 'cursos.md', docType: 'cursos', section: 'cursos', isActive: true, updatedAt: '2026-01-01T00:00:00Z', content }],
  })
  const answer = [
    'Tenemos dos cursos:',
    '**1. Toxina botulínica tercio superior**',
    'Fecha: 20 de noviembre de 2026 (en línea). Precio: $895 MXN.',
    '**2. Rejuvenecimiento facial tercio inferior (Botox inferior)**',
    'Precio: $895 MXN. Incluye constancia.',
  ].join('\n')
  const result = applyUpcomingCourseDateCorrection(answer, 'curso de botox', index.blocks, now, zone)
  assert.ok(result.includes(answer))
  assert.match(result, /24 de noviembre de 2026 \(en línea\)/)
  assert.equal((result.match(/20 de noviembre de 2026/g) || []).length, 1)
})

test('a missing online date does not remove a truthful unavailable in-person notice', () => {
  const answer = 'El curso de Eliminación de verrugas y manchas con Plasma Pen incluye práctica.\nNo hay fecha presencial programada.'
  const result = applyUpcomingCourseDateCorrection(answer, 'curso de verrugas online', blocks, now, zone)
  assert.match(result, /incluye práctica/)
  assert.match(result, /No hay fecha presencial programada/)
  assert.match(result, /9 de diciembre de 2026 \(en línea\)/)
})

test('an answer about a differently named card that says there is no date gets the calendar dates', () => {
  const answer = 'Tenemos el curso Eliminación de verrugas y manchas con Fibroblast. En este momento no hay una fecha programada para este curso.'
  const corrected = applyUpcomingCourseDateCorrection(answer, 'tienes cursos de verrugas y manchas?', blocks, now, zone)
  // The Fibroblast sentence stays (that card has no date); the calendar course is added
  assert.match(corrected, /^Tenemos el curso Eliminación de verrugas y manchas con Fibroblast\./)
  assert.match(corrected, /Plasma Pen es el 9 de diciembre de 2026 \(en línea\)/)
  assert.match(corrected, /plasma Pen es el 12 de noviembre de 2026 \(presencial\)/)
  // A question about another course adds nothing
  assert.equal(applyUpcomingCourseDateCorrection('No hay fecha para microblading.', 'curso de microblading', blocks, now, zone), 'No hay fecha para microblading.')
})

test('an answer that denies the dates is still corrected', () => {
  const answer = 'El curso de Eliminación de verrugas y manchas con Plasma Pen no tiene fecha programada. Escríbenos por WhatsApp.'
  const corrected = applyUpcomingCourseDateCorrection(answer, 'tienes cursos de verrugas y manchas?', blocks, now, zone)
  assert.doesNotMatch(corrected, /no tiene fecha/)
  assert.match(corrected, /12 de noviembre de 2026 \(presencial\)/)
  assert.match(corrected, /9 de diciembre de 2026 \(en línea\)/)
})

test('the modality asked for does not hide the course and picks its dates', () => {
  assert.deepEqual(describe('tienes cursos presenciales de verrugas y manchas?'), ['2026-11-12 presencial Eliminación de verrugas y manchas con plasma Pen'])
  assert.deepEqual(describe('curso de verrugas en línea'), ['2026-12-9 en línea Eliminación de verrugas y manchas con Plasma Pen'])
  assert.deepEqual(describe('cursos online de verrugas'), ['2026-12-9 en línea Eliminación de verrugas y manchas con Plasma Pen'])
  assert.equal(describe('tienes curso para quitar verrugas?').length, 2)
  const block = buildAskedCourseDatesBlock(findAskedCourseDates('tienes cursos presenciales de verrugas y manchas?', blocks, now, zone))
  assert.match(block, /modalidad presencial/)
  assert.match(block, /coinciden con la pregunta:\n- 12 de noviembre de 2026 \(presencial\)/)
  assert.match(block, /otra modalidad[^\n]*:\n- 9 de diciembre de 2026 \(en línea\)/)
})

test('a course without a date in the asked modality offers the other one and that modality\'s courses', () => {
  const asked = findAskedCourseDates('hay curso de peeling presencial?', blocks, now, zone)
  assert.deepEqual(getUpcomingCourseDates('hay curso de peeling presencial?', blocks, now, zone), [])
  const block = buildAskedCourseDatesBlock(asked)
  assert.match(block, /no tienen fecha presencial vigente; sí la tienen en otra modalidad[^\n]*\n- 11 de noviembre de 2026 \(en línea\): Peeling químico/)
  assert.match(block, /Otros cursos con fecha presencial vigente que puedes sugerirle:\n- 5 de noviembre de 2026 \(presencial\): Rejuvenecimiento/)
  assert.doesNotMatch(block.split('Otros cursos')[1], /en línea/)
})

test('a course not in the calendar gets similar ones, and the asked modality\'s courses', () => {
  const lunares = buildAskedCourseDatesBlock(findAskedCourseDates('curso de lunares y verrugas', blocks, now, zone))
  assert.match(lunares, /Cursos parecidos con fecha vigente[^\n]*\n- 12 de noviembre de 2026 \(presencial\): Eliminación de verrugas[^\n]*\n- 9 de diciembre/)
  const microblading = buildAskedCourseDatesBlock(findAskedCourseDates('tienes cursos presenciales de microblading?', blocks, now, zone))
  assert.match(microblading, /Cursos con fecha presencial vigente en el calendario:\n- 5 de noviembre/)
  assert.doesNotMatch(microblading, /en línea\)/)
})

test('an answer saying there are no in-person courses gets the in-person date', () => {
  const answer = 'Por el momento no hay disponibles cursos presenciales de verrugas y manchas.'
  const corrected = applyUpcomingCourseDateCorrection(answer, 'tienes cursos presenciales de verrugas y manchas?', blocks, now, zone)
  assert.match(corrected, /12 de noviembre de 2026 \(presencial\)/)
  assert.doesNotMatch(corrected, /9 de diciembre/)
})
