import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFlowRole, type FlowRoleInput } from '../access'

const owner = { userId: 'u-owner', organizationId: 'org-a' }
const teammate = { userId: 'u-team', organizationId: 'org-a' }
const outsider = { userId: 'u-out', organizationId: 'org-b' }
const flow = (over: Partial<FlowRoleInput> = {}): FlowRoleInput => ({
  organizationId: 'org-a', visibility: 'shared', userId: 'u-owner',
  shareToken: null, shareRole: 'view', collaboratorRole: null, ...over,
})

test('same-org semantics match v1 exactly', () => {
  assert.equal(resolveFlowRole(flow(), teammate), 'edit')                                     // shared → org edits
  assert.equal(resolveFlowRole(flow({ visibility: 'view' }), teammate), 'view')               // view → org views
  assert.equal(resolveFlowRole(flow({ visibility: 'view' }), owner), 'edit')                  // owner edits
  assert.equal(resolveFlowRole(flow({ visibility: 'view', userId: null }), teammate), 'edit') // legacy ownerless
  assert.equal(resolveFlowRole(flow({ visibility: 'private' }), teammate), null)              // private hidden
  assert.equal(resolveFlowRole(flow({ visibility: 'private' }), owner), 'edit')               // owner sees own
})

test('cross-org: collaborator row wins; a valid token grants shareRole; else invisible', () => {
  assert.equal(resolveFlowRole(flow(), outsider), null)
  assert.equal(resolveFlowRole(flow({ collaboratorRole: 'view' }), outsider), 'view')
  assert.equal(resolveFlowRole(flow({ collaboratorRole: 'edit' }), outsider), 'edit')
  assert.equal(resolveFlowRole(flow({ shareToken: 'tok', shareRole: 'edit' }), outsider, 'tok'), 'edit')
  assert.equal(resolveFlowRole(flow({ shareToken: 'tok', shareRole: 'view' }), outsider, 'tok'), 'view')
  assert.equal(resolveFlowRole(flow({ shareToken: 'tok' }), outsider, 'nope'), null)
  assert.equal(resolveFlowRole(flow({ shareToken: null }), outsider, 'tok'), null)
})
