import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCourseListReply, buildDbDocumentsContextBlock, findUnavailableCourseModalities } from './dbChat.js'
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
