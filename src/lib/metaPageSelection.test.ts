import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldShowConnectPage } from './metaPageSelection.ts'

test('only an unconnected selected page can be connected', () => {
  assert.equal(shouldShowConnectPage(undefined, undefined), false)
  assert.equal(shouldShowConnectPage('page-a', undefined), true)
  assert.equal(shouldShowConnectPage('page-a', 'page-a'), false)
  assert.equal(shouldShowConnectPage('page-b', 'page-a'), true)
  assert.equal(shouldShowConnectPage('page-b', 'page-b'), false)
})
