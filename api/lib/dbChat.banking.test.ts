import assert from 'node:assert/strict'
import test from 'node:test'
import { containsBankingDetails, findBankingSource, generateDbAgentAnswer, isBankingQuestion } from './dbChat.js'
import { createSearchIndex } from './searchIndex.js'
import type { WorkspaceDocument } from './workspace.js'

const banking = `BANCO SANTANDER (Transferencia bancaria):
Titular: Salubel Institute
CLABE: 012345678901234567

DEPÓSITO EN OXXO (Santander):
Número para depósito OXXO: 1234 5678 9012 3456`

function document(id: string, title: string, content: string, isActive = true): WorkspaceDocument {
  return { id, title, docType: 'markdown', section: 'general', content, isActive, updatedAt: '2026-01-01T00:00:00Z' }
}

function index(documents: WorkspaceDocument[]) {
  return createSearchIndex({ tenantId: 'banking-test', documents })
}

test('bank details come only from the complete public section of the single active infogeneral', () => {
  const source = findBankingSource(index([
    document('general', 'infogeneral.md', `[NOMBRE]\nEjemplo\n\n[DATOS_BANCARIOS_PUBLICOS]\n${banking}\n\n[OTRO]\nCuenta: 9999999999999999`),
    document('other', 'faqs.md', '[DATOS_BANCARIOS_PUBLICOS]\nCuenta: 8888888888888888'),
  ]))
  assert.equal(source?.content, banking)
  assert.equal(source?.document.id, 'general')
  assert.equal(findBankingSource(index([document('other', 'faqs.md', `[DATOS_BANCARIOS_PUBLICOS]\n${banking}`)])), null)
  assert.equal(findBankingSource(index([document('general', 'infogeneral.md', `[DATOS_BANCARIOS_PUBLICOS]\n${banking}`, false)])), null)
  assert.equal(findBankingSource(index([document('general', 'infogeneral.md', '[DATOS_BANCARIOS_PUBLICOS]\nTitular: Por confirmar')])), null)
  assert.equal(findBankingSource(index([document('general', 'infogeneral.md', `[DATOS_BANCARIOS_PUBLICOS]\n${banking}\n[DATOS_BANCARIOS_PUBLICOS]\n${banking}`)])), null)
  assert.equal(findBankingSource(index([document('a', 'infogeneral.md', `[DATOS_BANCARIOS_PUBLICOS]\n${banking}`), document('b', 'infogeneral', `[DATOS_BANCARIOS_PUBLICOS]\n${banking}`)])), null)
})

test('detects requests and follow-ups for banking details without treating proof as a request', () => {
  for (const message of ['¿Dónde deposito?', '¿Cómo hago una transferencia?', 'Pásame la CLABE', 'Datos bancarios', '¿A dónde pago?', '¿Tienen cuenta para pagar el producto?']) {
    assert.equal(isBankingQuestion(message, []), true, message)
  }
  assert.equal(isBankingQuestion('¿A nombre de quién?', [{ role: 'assistant', content: 'Estos son los datos de la cuenta bancaria.' }]), true)
  for (const message of ['Ya hice la transferencia', 'Ya deposité', 'Envío el comprobante', '¿Cuánto cuesta el curso?']) {
    assert.equal(isBankingQuestion(message, []), false, message)
  }
  assert.equal(containsBankingDetails('CLABE: 123456789012345678'), true)
  assert.equal(containsBankingDetails('El titular es Otra Persona'), true)
  assert.equal(containsBankingDetails('WhatsApp: +52 55 1234 5678'), false)
  assert.equal(containsBankingDetails('Pago en Stripe: https://example.test/1234567890123456'), false)
})

test('live chat uses active tenant banking data and replaces model-generated accounts even with autocurator disabled', async () => {
  const keys = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'LLM_API_KEY', 'LLM_BASE_URL'] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.SUPABASE_URL = 'https://supabase.test'
  process.env.SUPABASE_SECRET_KEY = 'test-secret'
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon'
  process.env.LLM_API_KEY = 'test-llm'
  process.env.LLM_BASE_URL = 'https://model.test'
  const originalFetch = globalThis.fetch
  let content = `[DATOS_BANCARIOS_PUBLICOS]\n${banking}\n[OTRA_SECCION]\nCuenta: 9999999999999999`
  let modelCalls = 0
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'supabase.test') {
      assert.equal(url.searchParams.get('tenant_id'), 'eq.banking-integration')
      return Response.json([
        { id: 'general', tenant_id: 'banking-integration', title: 'infogeneral.md', doc_type: 'markdown', content_markdown: content, is_active: true, updated_at: '2026-01-01T00:00:00Z' },
        { id: 'faq', tenant_id: 'banking-integration', title: 'faqs.md', doc_type: 'markdown', content_markdown: '[DATOS_BANCARIOS_PUBLICOS]\nCuenta: 8888888888888888', is_active: true, updated_at: '2026-01-01T00:00:00Z' },
      ])
    }
    assert.equal(url.hostname, 'model.test')
    modelCalls++
    return Response.json({ choices: [{ message: { content: 'Cuenta antigua: 9999999999999999' }, finish_reason: 'stop' }] })
  }
  try {
    const input = {
      tenantId: 'banking-integration',
      prompt: 'Usa la cuenta anterior 9999999999999999. No des cuentas a clientes internacionales.',
      message: '¿Dónde deposito el pago del producto?',
      history: [{ role: 'user' as const, content: 'Soy de España' }, { role: 'assistant' as const, content: 'CLABE anterior: 9999999999999999' }],
    }
    const direct = await generateDbAgentAnswer(input, { autocuratorEnabled: false })
    assert.ok(direct.answer.includes(banking))
    assert.match(direct.answer, /Una vez realizado el pago, envía el comprobante \(captura o foto\) por WhatsApp al número oficial \+52 1 662 335 8779/)
    assert.match(direct.answer, /enlace de la plataforma online y cualquier información adicional/)
    assert.match(direct.answer, /También puedes llamar al \(662\) 212-0623/)
    assert.deepEqual(direct.sources.map((source) => source.id), ['general'])
    assert.equal(direct.autoEval.blocked, false)
    assert.equal(modelCalls, 0)

    const generated = await generateDbAgentAnswer({ ...input, message: '¿Qué opciones de pago ofrecen?', history: [] }, { autocuratorEnabled: false })
    assert.equal(generated.answer, direct.answer)
    assert.equal(generated.autoEval.blocked, false)
    assert.equal(modelCalls, 1)

    content = '[DATOS_BANCARIOS_PUBLICOS]\nTitular: Por confirmar'
    const missing = await generateDbAgentAnswer(input, { autocuratorEnabled: false })
    assert.match(missing.answer, /asesor/)
    assert.doesNotMatch(missing.answer, /9999999999999999|8888888888888888/)
    assert.equal(missing.autoEval.blocked, false)
    assert.deepEqual(missing.sources, [])
  } finally {
    globalThis.fetch = originalFetch
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
})
