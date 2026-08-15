export type AnnotationComposerLabels = {
  dialog: string
  comment: string
  placeholder: string
  intent: string
  change: string
  fix: string
  question: string
  approve: string
  cancel: string
  save: string
}

export type AnnotationComposerAnchor = {
  x: number
  y: number
  below: boolean
}

export type AnnotationComposerOutcome =
  | { kind: 'submit'; comment: string; intent: string }
  | { kind: 'cancel' }

export function buildShowAnnotationComposerScript(args: {
  label: string
  selector: string
  labels: AnnotationComposerLabels
  anchor: AnnotationComposerAnchor
}): string {
  return `(() => {
    const card = document.getElementById('annotation-composer');
    const title = document.getElementById('annotation-label');
    const selector = document.getElementById('annotation-selector');
    const comment = document.getElementById('annotation-comment');
    const save = document.getElementById('annotation-save');
    const cancel = document.getElementById('annotation-cancel');
    const intentLabel = document.getElementById('annotation-intent-label');
    if (!card || !title || !selector || !comment || !save || !cancel || !intentLabel) return false;

    title.textContent = ${JSON.stringify(args.label)};
    selector.textContent = ${JSON.stringify(args.selector)};
    card.setAttribute('aria-label', ${JSON.stringify(args.labels.dialog)});
    comment.setAttribute('aria-label', ${JSON.stringify(args.labels.comment)});
    comment.placeholder = ${JSON.stringify(args.labels.placeholder)};
    intentLabel.textContent = ${JSON.stringify(args.labels.intent)};
    save.textContent = ${JSON.stringify(args.labels.save)};
    cancel.textContent = ${JSON.stringify(args.labels.cancel)};
    const intents = {
      change: ${JSON.stringify(args.labels.change)},
      fix: ${JSON.stringify(args.labels.fix)},
      question: ${JSON.stringify(args.labels.question)},
      approve: ${JSON.stringify(args.labels.approve)}
    };
    card.querySelectorAll('[data-intent]').forEach((button) => {
      const key = button.getAttribute('data-intent');
      if (key && intents[key]) button.textContent = intents[key];
      button.setAttribute('aria-pressed', key === 'change' ? 'true' : 'false');
    });
    comment.value = '';
    save.disabled = true;
    card.dataset.intent = 'change';
    card.style.display = 'flex';
    card.setAttribute('aria-hidden', 'false');
    const x = ${JSON.stringify(args.anchor.x)};
    const y = ${JSON.stringify(args.anchor.y)};
    const below = ${JSON.stringify(args.anchor.below)};
    card.style.left = x + 'px';
    card.style.top = y + 'px';
    card.style.transform = below ? 'translate(-50%, 10px)' : 'translate(-50%, calc(-100% - 10px))';
    comment.focus();
    return true;
  })()`
}

export function buildPositionAnnotationComposerScript(anchor: AnnotationComposerAnchor): string {
  return `(() => {
    const card = document.getElementById('annotation-composer');
    if (!card || card.style.display === 'none') return false;
    card.style.left = ${JSON.stringify(anchor.x)} + 'px';
    card.style.top = ${JSON.stringify(anchor.y)} + 'px';
    card.style.transform = ${JSON.stringify(anchor.below)} ? 'translate(-50%, 10px)' : 'translate(-50%, calc(-100% - 10px))';
    return true;
  })()`
}

export function buildHideAnnotationComposerScript(): string {
  return `(() => {
    const card = document.getElementById('annotation-composer');
    if (!card) return true;
    const resolve = window.__kataAnnotationComposerResolve;
    window.__kataAnnotationComposerResolve = null;
    card.style.display = 'none';
    card.setAttribute('aria-hidden', 'true');
    if (typeof resolve === 'function') resolve({ kind: 'cancel' });
    return true;
  })()`
}

export function buildBindAnnotationComposerShieldScript(): string {
  return `(() => {
    const overlay = document.getElementById('overlay');
    const chip = document.getElementById('chip');
    const shield = document.getElementById('shield');
    const card = document.getElementById('annotation-composer');
    if (!overlay || !chip || !shield) return false;
    overlay.style.borderColor = 'transparent';
    overlay.style.boxShadow = 'none';
    chip.style.display = 'none';
    shield.style.pointerEvents = 'auto';
    shield.style.cursor = 'default';
    shield.style.background = 'transparent';
    shield.onclick = (event) => {
      if (event.target !== shield) return;
      const resolve = window.__kataAnnotationComposerResolve;
      if (typeof resolve !== 'function') return;
      window.__kataAnnotationComposerResolve = null;
      if (card) {
        card.style.display = 'none';
        card.setAttribute('aria-hidden', 'true');
      }
      resolve({ kind: 'cancel' });
    };
    return true;
  })()`
}

export function buildUnbindAnnotationComposerShieldScript(): string {
  return `(() => {
    const shield = document.getElementById('shield');
    if (!shield) return true;
    shield.onclick = null;
    return true;
  })()`
}

export function buildAwaitAnnotationComposerScript(): string {
  return `(async function() {
    return await new Promise(function(resolve) {
      const card = document.getElementById('annotation-composer');
      const comment = document.getElementById('annotation-comment');
      const save = document.getElementById('annotation-save');
      const cancel = document.getElementById('annotation-cancel');
      if (!card || !comment || !save || !cancel) {
        resolve({ kind: 'cancel' });
        return;
      }
      window.__kataAnnotationComposerResolve = resolve;
      const finish = (result) => {
        if (window.__kataAnnotationComposerResolve !== resolve) return;
        window.__kataAnnotationComposerResolve = null;
        card.style.display = 'none';
        card.setAttribute('aria-hidden', 'true');
        resolve(result);
      };
      comment.oninput = () => {
        save.disabled = comment.value.trim().length === 0;
      };
      save.onclick = () => {
        const text = comment.value.trim();
        if (!text) return;
        finish({ kind: 'submit', comment: text, intent: card.dataset.intent || 'change' });
      };
      cancel.onclick = () => finish({ kind: 'cancel' });
      card.querySelectorAll('[data-intent]').forEach((button) => {
        button.onclick = () => {
          card.dataset.intent = button.getAttribute('data-intent') || 'change';
          card.querySelectorAll('[data-intent]').forEach((item) => {
            item.setAttribute('aria-pressed', item === button ? 'true' : 'false');
          });
        };
      });
      comment.onkeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          finish({ kind: 'cancel' });
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          const text = comment.value.trim();
          if (!text) return;
          event.preventDefault();
          finish({ kind: 'submit', comment: text, intent: card.dataset.intent || 'change' });
        }
      };
    });
  })()`
}

export const ANNOTATION_COMPOSER_MARKUP = `
      <div id="annotation-composer" role="dialog" aria-hidden="true" aria-label="Add browser annotation">
        <div id="annotation-label"></div>
        <div id="annotation-selector"></div>
        <textarea id="annotation-comment" maxlength="2000"></textarea>
        <div id="annotation-intent-label"></div>
        <div id="annotation-intents">
          <button type="button" data-intent="change" aria-pressed="true">Change</button>
          <button type="button" data-intent="fix">Fix</button>
          <button type="button" data-intent="question">Question</button>
          <button type="button" data-intent="approve">Approve</button>
        </div>
        <div id="annotation-actions">
          <button type="button" id="annotation-cancel">Cancel</button>
          <button type="button" id="annotation-save" disabled>Add</button>
        </div>
      </div>`

export const ANNOTATION_COMPOSER_STYLES = `
      #annotation-composer {
        display: none;
        position: absolute;
        z-index: 3;
        width: 22rem;
        max-width: calc(100vw - 24px);
        box-sizing: border-box;
        flex-direction: column;
        gap: 8px;
        padding: 12px;
        border-radius: 12px;
        background: rgba(250, 250, 251, 0.97);
        color: #111827;
        box-shadow: 0 10px 24px rgba(0,0,0,0.18);
        pointer-events: auto;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      @media (prefers-color-scheme: dark) {
        #annotation-composer {
          background: rgba(32, 30, 36, 0.97);
          color: #f3f4f6;
        }
      }
      #annotation-label { font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #annotation-selector { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #annotation-comment {
        width: 100%;
        height: 96px;
        resize: none;
        box-sizing: border-box;
        border-radius: 8px;
        border: 1px solid rgba(0,0,0,0.12);
        padding: 8px;
        background: transparent;
        color: inherit;
        font: inherit;
      }
      #annotation-intent-label { font-size: 11px; opacity: 0.7; }
      #annotation-intents, #annotation-actions { display: flex; gap: 6px; flex-wrap: wrap; }
      #annotation-composer button {
        border: 1px solid rgba(0,0,0,0.12);
        background: transparent;
        color: inherit;
        border-radius: 7px;
        padding: 4px 8px;
        font: inherit;
        cursor: pointer;
      }
      #annotation-composer button[aria-pressed="true"],
      #annotation-save {
        background: #111827;
        color: #fff;
        border-color: transparent;
      }
      #annotation-save:disabled { opacity: 0.4; cursor: default; }
`
