import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'bun:test'
import {
  buildAwaitAnnotationComposerScript,
  buildBindAnnotationComposerShieldScript,
  buildHideAnnotationComposerScript,
  buildShowAnnotationComposerScript,
  buildUnbindAnnotationComposerShieldScript,
} from '../composer-overlay'

function createComposerSandbox() {
  const intents = ['change', 'fix', 'question', 'approve'].map((key) => {
    const attrs: Record<string, string> = {
      'data-intent': key,
      'aria-pressed': key === 'change' ? 'true' : 'false',
    }
    return {
      key,
      textContent: key,
      attrs,
      onclick: null as ((event?: unknown) => void) | null,
      getAttribute(name: string) {
        return attrs[name] ?? null
      },
      setAttribute(name: string, value: string) {
        attrs[name] = value
      },
    }
  })

  const makeEl = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    style: {
      display: 'none',
      left: '',
      top: '',
      transform: '',
      borderColor: '',
      boxShadow: '',
      pointerEvents: '',
      cursor: '',
      background: '',
    },
    dataset: { intent: 'change' },
    textContent: '',
    value: '',
    disabled: true,
    placeholder: '',
    focused: false,
    onclick: null as ((event?: { target?: unknown }) => void) | null,
    oninput: null as (() => void) | null,
    onkeydown: null as ((event: { key: string; metaKey?: boolean; ctrlKey?: boolean; preventDefault: () => void }) => void) | null,
    attrs: {} as Record<string, string>,
    setAttribute(name: string, value: string) {
      this.attrs[name] = value
    },
    getAttribute(name: string) {
      return this.attrs[name] ?? null
    },
    focus() {
      this.focused = true
    },
    querySelectorAll(selector: string) {
      return selector === '[data-intent]' ? intents : []
    },
    ...extra,
  })

  const card = makeEl('annotation-composer')
  const comment = makeEl('annotation-comment')
  const save = makeEl('annotation-save')
  const cancel = makeEl('annotation-cancel')
  const shield = makeEl('shield')
  const overlay = makeEl('overlay')
  const chip = makeEl('chip')
  const byId: Record<string, ReturnType<typeof makeEl> | null> = {
    'annotation-composer': card,
    'annotation-label': makeEl('annotation-label'),
    'annotation-selector': makeEl('annotation-selector'),
    'annotation-comment': comment,
    'annotation-save': save,
    'annotation-cancel': cancel,
    'annotation-intent-label': makeEl('annotation-intent-label'),
    overlay,
    chip,
    shield,
  }

  const sandbox = {
    Promise,
    window: { __kataAnnotationComposerResolve: null as ((result: unknown) => void) | null },
    document: {
      getElementById(id: string) {
        return byId[id] ?? null
      },
    },
  }

  return { sandbox, card, comment, save, cancel, shield, intents }
}

const labels = {
  dialog: 'Add browser annotation',
  comment: 'Comment',
  placeholder: 'What should change?',
  intent: 'Intent',
  change: 'Change',
  fix: 'Fix',
  question: 'Question',
  approve: 'Approve',
  cancel: 'Cancel',
  save: 'Add',
}

describe('annotation composer overlay scripts', () => {
  it('localizes the dialog and keeps save disabled until a comment is entered', () => {
    const { sandbox, card, comment, save } = createComposerSandbox()
    const shown = runInNewContext(
      buildShowAnnotationComposerScript({
        label: 'Start free trial',
        selector: 'main > button.primary',
        labels,
        anchor: { x: 40, y: 80, below: true },
      }),
      sandbox,
    )
    expect(shown).toBe(true)
    expect(card.attrs['aria-label']).toBe('Add browser annotation')
    expect(comment.placeholder).toBe('What should change?')
    expect(save.disabled).toBe(true)
    expect(card.dataset.intent).toBe('change')

    runInNewContext(buildAwaitAnnotationComposerScript(), sandbox)
    comment.value = '  Make the CTA clearer.  '
    comment.oninput?.()
    expect(save.disabled).toBe(false)
  })

  it('submits the selected intent on save and Cmd+Enter, and cancels on Escape', async () => {
    const submitSandbox = createComposerSandbox()
    runInNewContext(
      buildShowAnnotationComposerScript({
        label: 'Save',
        selector: 'button',
        labels,
        anchor: { x: 10, y: 10, below: false },
      }),
      submitSandbox.sandbox,
    )
    const submitPromise = runInNewContext(buildAwaitAnnotationComposerScript(), submitSandbox.sandbox) as Promise<{
      kind: string
      comment?: string
      intent?: string
    }>
    submitSandbox.intents[1]!.onclick?.()
    expect(submitSandbox.card.dataset.intent).toBe('fix')
    submitSandbox.comment.value = 'Fix the label'
    submitSandbox.save.onclick?.()
    await expect(submitPromise).resolves.toEqual({
      kind: 'submit',
      comment: 'Fix the label',
      intent: 'fix',
    })

    const shortcutSandbox = createComposerSandbox()
    runInNewContext(
      buildShowAnnotationComposerScript({
        label: 'Save',
        selector: 'button',
        labels,
        anchor: { x: 10, y: 10, below: true },
      }),
      shortcutSandbox.sandbox,
    )
    const shortcutPromise = runInNewContext(buildAwaitAnnotationComposerScript(), shortcutSandbox.sandbox) as Promise<{
      kind: string
      comment?: string
      intent?: string
    }>
    shortcutSandbox.comment.value = 'Submit from keyboard'
    shortcutSandbox.comment.onkeydown?.({
      key: 'Enter',
      metaKey: true,
      preventDefault() {},
    })
    await expect(shortcutPromise).resolves.toEqual({
      kind: 'submit',
      comment: 'Submit from keyboard',
      intent: 'change',
    })

    const cancelSandbox = createComposerSandbox()
    runInNewContext(
      buildShowAnnotationComposerScript({
        label: 'Save',
        selector: 'button',
        labels,
        anchor: { x: 10, y: 10, below: true },
      }),
      cancelSandbox.sandbox,
    )
    const cancelPromise = runInNewContext(buildAwaitAnnotationComposerScript(), cancelSandbox.sandbox) as Promise<{
      kind: string
    }>
    cancelSandbox.comment.onkeydown?.({
      key: 'Escape',
      preventDefault() {},
    })
    await expect(cancelPromise).resolves.toEqual({ kind: 'cancel' })
  })

  it('does not submit an empty comment and cancels from the shield', async () => {
    const { sandbox, comment, save, shield } = createComposerSandbox()
    runInNewContext(
      buildShowAnnotationComposerScript({
        label: 'Save',
        selector: 'button',
        labels,
        anchor: { x: 10, y: 10, below: true },
      }),
      sandbox,
    )
    const pending = runInNewContext(buildAwaitAnnotationComposerScript(), sandbox) as Promise<{ kind: string }>
    comment.value = '   '
    save.onclick?.()
    expect(sandbox.window.__kataAnnotationComposerResolve).not.toBeNull()

    runInNewContext(buildBindAnnotationComposerShieldScript(), sandbox)
    shield.onclick?.({ target: shield })
    await expect(pending).resolves.toEqual({ kind: 'cancel' })

    runInNewContext(buildUnbindAnnotationComposerShieldScript(), sandbox)
    expect(shield.onclick).toBeNull()
    expect(runInNewContext(buildHideAnnotationComposerScript(), sandbox)).toBe(true)
  })
})
