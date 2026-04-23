const LOG_PREFIX = '[HME:UI]';
const SCRIPT_VERSION = '2026-04-21-8';
const STEP_DELAY_MS = 3000;
let running = false;
let paused = false;

const DEFAULT_SETTINGS = {
  retryMax: 2,
  retryDelayMinMs: 800,
  retryDelayMaxMs: 1400,
};

function debugLog(message, data) {
  try {
    chrome.runtime.sendMessage({ type: 'HME_DEBUG', message, data });
  } catch (_) {}
  try {
    console.log(LOG_PREFIX, message, data || '');
  } catch (_) {}
}

function ensureNotPaused() {
  if (paused) throw new Error('paused');
}

function reportStep(step, status, error) {
  try {
    chrome.runtime.sendMessage({
      type: 'FLOW_STEP',
      step,
      status,
      error: error ? String(error) : '',
    });
  } catch (_) {}
}



function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stepDelay(label) {
  if (label) {
    debugLog(`${label}，等待 ${STEP_DELAY_MS / 1000} 秒`);
  }
  return sleep(STEP_DELAY_MS);
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanDelay(min = 300, max = 900) {
  await sleep(rand(min, max));
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function queryAllDeep(selectors, root = document) {
  const results = [];
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    try {
      results.push(...node.querySelectorAll(selectors));
    } catch (_) {}
    const tree = node.querySelectorAll ? node.querySelectorAll('*') : [];
    for (const el of tree) {
      if (el.shadowRoot) queue.push(el.shadowRoot);
    }
  }
  return results;
}

function getAllRoots() {
  const roots = [document];
  const frames = document.querySelectorAll('iframe');
  for (const frame of frames) {
    try {
      const doc = frame.contentDocument;
      if (doc && !roots.includes(doc)) roots.push(doc);
    } catch (_) {}
  }
  return roots;
}

function findInRoots(fn) {
  const roots = getAllRoots();
  for (const root of roots) {
    const result = fn(root);
    if (result) return result;
  }
  return null;
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function getElementText(el) {
  if (!el) return '';
  const text = [
    el.innerText,
    el.textContent,
    el.getAttribute?.('aria-label'),
    el.getAttribute?.('title'),
    el.getAttribute?.('alt'),
  ].filter(Boolean).join(' ');
  return normalizeText(text);
}

function textMatch(el, texts) {
  const text = getElementText(el);
  if (!text) return false;
  return texts.some(t => text.includes(t));
}

function textOf(el) {
  return getElementText(el);
}

function setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (el.isContentEditable) {
    el.textContent = value;
  } else if (desc && desc.set) {
    desc.set.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

function findClickableByText(texts, root = document) {
  const candidates = queryAllDeep(
    'button, a, div[role="button"], span[role="button"], input[type="button"], input[type="submit"]',
    root
  );
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    if (textMatch(el, texts)) return el;
  }
  // Fallback: find nearest clickable ancestor of a text node.
  const textNodes = queryAllDeep('*', root).filter(el => textMatch(el, texts));
  for (const el of textNodes) {
    const clickable = el.closest('button, a, [role="button"]');
    if (clickable && isVisible(clickable)) return clickable;
  }
  return null;
}

function findInputByPlaceholder(texts, root = document) {
  const inputs = queryAllDeep('input, textarea, [contenteditable="true"], [role="textbox"]', root);
  for (const el of inputs) {
    const ph = normalizeText(el.getAttribute('placeholder') || '');
    const aria = normalizeText(el.getAttribute('aria-label') || '');
    let labelText = normalizeText(`${ph} ${aria}`);
    const id = el.getAttribute('id');
    if (id) {
      const lbl = root.querySelector(`label[for="${id}"]`);
      if (lbl) labelText = normalizeText(`${labelText} ${textOf(lbl)}`);
    }
    if (el.closest('label')) {
      labelText = normalizeText(`${labelText} ${textOf(el.closest('label'))}`);
    }
    if (texts.some(t => labelText.includes(t)) && isVisible(el)) return el;
  }
  return null;
}

function findInputByKeywords(texts, root = document) {
  const explicit = findLabelInput(root);
  if (explicit) return explicit;
  const found = findInputByPlaceholder(texts, root);
  if (found) return found;
  const inputs = queryAllDeep('input, textarea, [contenteditable="true"], [role="textbox"]', root)
    .filter(el => isVisible(el) && !el.disabled && el.type !== 'hidden');
  if (!inputs.length) return null;

  let best = null;
  let bestScore = 0;
  for (const el of inputs) {
    const name = normalizeText(el.getAttribute('name') || '');
    const id = normalizeText(el.getAttribute('id') || '');
    const aria = normalizeText(el.getAttribute('aria-label') || '');
    const ph = normalizeText(el.getAttribute('placeholder') || '');
    const label = el.closest('label') ? textOf(el.closest('label')) : '';
    const hay = normalizeText(`${name} ${id} ${aria} ${ph} ${label}`);
    const score = texts.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (best) return best;
  if (inputs.length === 1) return inputs[0];
  return null;
}

function findLabelInput(root = document) {
  const selectors = [
    'input.form-textbox-input',
    'input[role="textbox"][name*="为电子邮件地址设置标签"]',
    'input[placeholder*="为电子邮件地址设置标签"]',
    'input[placeholder*="设置标签"]',
    'input[placeholder*="标签"]',
    '[role="textbox"][aria-label*="标签"]',
    '[contenteditable="true"][aria-label*="标签"]',
    '[contenteditable="true"][placeholder*="标签"]',
  ];
  const roots = getAllRoots();
  for (const r of roots) {
    for (const sel of selectors) {
      const el = r.querySelector(sel);
      if (el && isVisible(el) && !el.disabled) return el;
    }
  }
  return null;
}

function findTextarea(root = document) {
  const ta = queryAllDeep('textarea', root).find(el => isVisible(el) && !el.disabled);
  return ta || null;
}

function findExactLabelInput(root = document) {
  return queryAllDeep(
    'input[name="hme-label"], .AddEmail-inputs input[name="hme-label"], .AddEmail-inputs .form-textbox-input',
    root
  ).find(el => isVisible(el) && !el.disabled) || null;
}

function findExactNoteTextarea(root = document) {
  return queryAllDeep(
    'textarea[name="hme-note"], .AddEmail-inputs textarea[name="hme-note"], .AddEmail-inputs .form-textarea textarea',
    root
  ).find(el => isVisible(el) && !el.disabled) || null;
}

function findCreateButton(root = document) {
  const exactCreateButton = queryAllDeep('.modal-button-bar button, .button-bar button, button', root)
    .find(el => {
      if (!isVisible(el)) return false;
      const text = textOf(el);
      return /Create email address|创建电子邮件地址/i.test(text);
    });
  if (exactCreateButton) return exactCreateButton;

  const keywords = ['创建电子邮件地址', 'Create Email Address', '创建', 'Create'];
  const btn = findClickableByText(keywords, root);
  if (btn) return btn;

  const candidates = queryAllDeep('button, [role="button"]', root)
    .filter(el => isVisible(el));
  if (!candidates.length) return null;

  const byAria = candidates.find(el => {
    const aria = normalizeText(el.getAttribute('aria-label') || '');
    const title = normalizeText(el.getAttribute('title') || '');
    const text = normalizeText(`${aria} ${title}`);
    return keywords.some(k => text.includes(k));
  });
  if (byAria) return byAria;

  const submit = candidates.find(el => el.getAttribute('type') === 'submit');
  if (submit) return submit;

  const primary = candidates.find(el => {
    const cls = String(el.className || '');
    const text = textOf(el);
    if (/返回|Back|取消|Cancel|关闭|Close/i.test(text)) return false;
    return /primary|btn-primary|button-primary|blue|cta/i.test(cls);
  });
  if (primary) return primary;

  return null;
}

async function humanClick(el) {
  if (!el) throw new Error('Element not found');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await humanDelay(200, 500);
  try {
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse', isPrimary: true }));
  } catch (_) {}
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await humanDelay(100, 300);
  try {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }));
  } catch (_) {}
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await humanDelay(80, 180);
  try {
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 }));
  } catch (_) {}
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  el.click();
  await humanDelay(400, 900);
}

function getElementCenterRect(el) {
  if (!el?.getBoundingClientRect) return null;
  const rect = el.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: rect.left + rect.width / 2,
    centerY: rect.top + rect.height / 2,
  };
}

async function requestDebuggerClick(el, label = 'element') {
  const rect = getElementCenterRect(el);
  if (!rect) {
    throw new Error(`无法获取 ${label} 的点击坐标`);
  }
  debugLog(`准备使用 debugger 点击 ${label}`, {
    centerX: Math.round(rect.centerX),
    centerY: Math.round(rect.centerY),
  });
  const response = await chrome.runtime.sendMessage({
    type: 'HME_DEBUGGER_CLICK',
    rect,
    label,
  });
  if (!response?.ok) {
    throw new Error(response?.error || `Debugger 点击 ${label} 失败`);
  }
  await humanDelay(600, 1000);
}

async function waitFor(fn, timeout = 15000, interval = 400) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = fn();
    if (result) return result;
    await sleep(interval);
  }
  return null;
}

function extractEmailFromDialog(root = document) {
  const nodes = queryAllDeep('*', root);
  for (const el of nodes) {
    const text = (el.innerText || el.textContent || '').trim();
    if (text.includes('@') && (text.includes('icloud') || text.includes('privaterelay'))) {
      const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      if (match) return match[0];
    }
  }
  const inputs = queryAllDeep('input', root);
  for (const input of inputs) {
    const val = (input.value || '').trim();
    if (val.includes('@')) return val;
  }
  return '';
}

function extractCreateError(root = document) {
  const exactMessages = [
    'You have reached the limit of addresses you can create right now. Please try again later.',
    'You have reached the limit of addresses you can create right now',
    '您目前可创建的地址数量已达上限，请稍后再试。',
    '您已达到当前可创建地址的上限，请稍后再试。',
  ];

  const nodes = queryAllDeep('*', root);
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    const text = normalizeText(el.innerText || el.textContent || '');
    if (!text) continue;

    const exact = exactMessages.find(message => text.includes(message));
    if (exact) return exact;

    const isEnglishLimit = /reached the limit of addresses you can create right now/i.test(text)
      || (/try again later/i.test(text) && /address|create/i.test(text));
    const isChineseLimit = /可创建.*地址.*上限/i.test(text)
      || (/请稍后再试/i.test(text) && /地址|创建/i.test(text));

    if (isEnglishLimit || isChineseLimit) {
      return text;
    }
  }

  return '';
}

function isHideMyEmailModal(root = document) {
  if (!root) return false;

  const ariaLabel = normalizeText(root.getAttribute?.('aria-label') || '');
  if (ariaLabel.includes('Hide My Email') || ariaLabel.includes('隐藏邮件地址')) {
    return true;
  }

  const heading = queryAllDeep('h1, h2, h3, .PanelTitle-title, .modal-title, [role="heading"]', root)
    .find(el => isVisible(el) && textMatch(el, ['隐藏邮件地址', 'Hide My Email']));
  if (!heading) return false;

  const addButton = queryAllDeep(
    '.IconButton.AddButton button[title="Add"], .IconButton.AddButton button, button[title="Add"]',
    root
  ).find(el => isVisible(el));

  return Boolean(addButton || heading);
}

function findHideMyEmailModal() {
  return findInRoots((root) => {
    const exactDialog = root.querySelector(
      '.modal-dialog[role="dialog"][aria-label="Hide My Email"], ' +
      '.modal-dialog[role="dialog"][aria-label*="Hide My Email"], ' +
      '[role="dialog"][aria-label="Hide My Email"], ' +
      '[role="dialog"][aria-label*="Hide My Email"]'
    );
    if (exactDialog && isVisible(exactDialog)) return exactDialog;

    const modalCandidates = queryAllDeep('.modal-dialog, .modal-content, [role="dialog"]', root)
      .filter(el => isVisible(el));
    return modalCandidates.find(candidate => isHideMyEmailModal(candidate)) || null;
  });
}

function findModalRoot() {
  const exactHideMyEmailModal = findHideMyEmailModal();
  if (exactHideMyEmailModal) return exactHideMyEmailModal;

  return findInRoots((root) => {
    const modalContent = root.querySelector('.modal-content.has-scroll-shadows, .modal-content');
    if (modalContent && isVisible(modalContent)) return modalContent;
    const dialog = root.querySelector('[role="dialog"][aria-modal="true"], [aria-modal="true"], [role="dialog"]');
    if (dialog && isVisible(dialog)) return dialog;
    const heading = queryAllDeep('h1, h2, h3, div, span', root)
      .find(el => isVisible(el) && textMatch(el, ['隐藏邮件地址', '创建新地址', '新地址', 'Hide My Email']));
    if (!heading) return null;
    let node = heading;
    for (let i = 0; i < 10 && node; i++) {
      const role = node.getAttribute && node.getAttribute('role');
      const modal = node.getAttribute && node.getAttribute('aria-modal');
      if (role === 'dialog' || modal === 'true') return node;
      const cls = String(node.className || '');
      if (/modal|dialog|sheet|overlay/i.test(cls)) return node;
      node = node.parentElement;
    }
    return null;
  });
}

function findExactHideMyEmailTile(root = document) {
  const exactTiles = queryAllDeep(
    'article.tile-article[aria-label="Hide My Email"], .tile-container article[aria-label="Hide My Email"], article[aria-label="Hide My Email"]',
    root
  ).filter(isVisible);

  for (const tile of exactTiles) {
    return tile;
  }

  return null;
}

function findHideMyEmailCardInRoot(root) {
  const keywords = ['隐藏邮件地址', '隐藏电子邮件地址', 'Hide My Email', '隐藏邮件'];

  const exactTile = findExactHideMyEmailTile(root);
  if (exactTile) return exactTile;

  const titles = queryAllDeep('h1, h2, h3', root)
    .filter(el => isVisible(el) && keywords.some(k => textOf(el).includes(k)));
  for (const title of titles) {
    const btn = title.closest('button, a, [role="button"]');
    if (btn) return btn;
    const card = title.closest('.card, .card-theme-module, .card-border, .card-rounded-rectangle, .card-shadow');
    if (card) return card.closest('button') || card;
  }

  const buttons = queryAllDeep('button.button.button-bare.button-expand.button-rounded-rectangle', root);
  for (const btn of buttons) {
    const title = btn.querySelector('h3.card-title');
    if (title && textMatch(title, keywords)) return btn;
    const text = (btn.innerText || btn.textContent || '').trim();
    if (keywords.some(k => text.includes(k))) return btn;
  }

  const nodes = queryAllDeep('h1,h2,h3,div,span,p,button,a', root);
  let best = null;
  let bestScore = Infinity;
  for (const el of nodes) {
    const text = (el.innerText || el.textContent || '').trim();
    if (!text) continue;
    if (!keywords.some(k => text.includes(k))) continue;
    if (!isVisible(el)) continue;
    const score = text.length;
    if (score < bestScore) {
      best = el;
      bestScore = score;
    }
  }
  if (best) {
    const clickable = best.closest('button, a, [role="button"]');
    if (clickable) return clickable;
    const card = best.closest('.card, .card-theme-module, .card-border, .card-rounded-rectangle, .card-shadow');
    if (card) return card.closest('button') || card;
    return best;
  }
  return null;
}

function findHideMyEmailCard() {
  return findInRoots(root => findHideMyEmailCardInRoot(root));
}

async function openAccountSettingsIfNeeded() {
  const settingsTexts = ['Account Settings', '账户设置', '帐户设置', '设置'];
  const settingsBtn = findClickableByText(settingsTexts);
  if (settingsBtn) {
    debugLog('检测到“账户设置”入口，准备点击');
    await humanClick(settingsBtn);
    debugLog('已点击“账户设置”入口');
    return true;
  }
  debugLog('未检测到“账户设置”入口，跳过此步骤');
  return false;
}

async function openHideMyEmailSection() {
  ensureNotPaused();
  reportStep(1, 'running');
  const texts = ['Hide My Email', '隐藏邮件地址', '隐藏电子邮件地址', '隐藏邮件', '隐藏我的邮件', '隐藏邮箱'];

  const attemptFindEntry = () => {
    const exactTile = findInRoots(root => findExactHideMyEmailTile(root));
    if (exactTile) return exactTile;
    const direct = findHideMyEmailCard();
    if (direct) return direct;
    return findInRoots(root => findClickableByText(texts, root));
  };

  const modalTitle = await waitFor(() => findHideMyEmailModal(), 2000, 200);
  if (modalTitle) {
    debugLog('已在当前页面检测到“隐藏邮件地址”弹窗，无需再点击入口');
    reportStep(1, 'done');
    return modalTitle;
  }

  debugLog('开始查找“隐藏邮件地址”入口卡片/按钮');
  let cardTarget = await waitFor(() => attemptFindEntry(), 12000, 500);
  if (!cardTarget) {
    debugLog('入口未找到，尝试滚动页面后重试');
    try {
      window.scrollTo({ top: 0, behavior: 'instant' });
      await humanDelay(300, 600);
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
      await humanDelay(300, 600);
      window.scrollTo({ top: 0, behavior: 'instant' });
    } catch (_) {}
    cardTarget = await waitFor(() => attemptFindEntry(), 12000, 500);
  }
  if (!cardTarget) {
    const frames = Array.from(document.querySelectorAll('iframe')).map(f => f.src || '(no src)');
    const samples = [];
    const roots = getAllRoots();
    for (const root of roots) {
      const nodes = queryAllDeep('h1,h2,h3,div,span,p', root)
        .filter(el => isVisible(el) && textMatch(el, ['隐藏', 'Hide']));
      for (const el of nodes.slice(0, 5)) {
        samples.push({
          text: textOf(el).slice(0, 60),
          tag: el.tagName,
          className: el.className
        });
      }
      if (samples.length >= 8) break;
    }
    debugLog('入口未找到（调试）', { frames, samples });
    throw new Error('未找到“隐藏邮件地址 / Hide My Email”入口');
  }
  debugLog('找到入口，准备使用 debugger 真点击', {
    text: textOf(cardTarget).slice(0, 80),
    tag: cardTarget.tagName,
    className: cardTarget.className
  });
  await requestDebuggerClick(cardTarget, 'Hide My Email tile');
  debugLog('已使用 debugger 点击“隐藏邮件地址”入口，等待弹窗出现');

  const modalRoot = await waitFor(() => findHideMyEmailModal(), 12000, 300);
  if (!modalRoot) throw new Error('已点击入口，但未检测到“隐藏邮件地址”弹窗');
  debugLog('“隐藏邮件地址”弹窗已打开');
  reportStep(1, 'done');
  return modalRoot;
}

function findPlusButton(root = document) {
  const exactAddButton = queryAllDeep(
    '.IconButton.AddButton button[title="Add"], .IconButton.AddButton button, button[title="Add"]',
    root
  ).find(el => isVisible(el));
  if (exactAddButton) return exactAddButton;

  const iconPlus = queryAllDeep('span.icon.icon-plus, i.icon-plus, svg[class*="plus"], [data-icon*="plus"]', root);
  for (const el of iconPlus) {
    const clickable = el.closest('button, a, div[role="button"], span[role="button"]');
    if (clickable && isVisible(clickable)) return clickable;
  }

  const candidates = queryAllDeep('button, a, div[role="button"], span[role="button"]', root);
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const text = textOf(el);
    if (text === '+' || text === '＋') return el;
    const aria = (el.getAttribute('aria-label') || '').trim();
    const title = (el.getAttribute('title') || '').trim();
    if (['添加', '新增', '创建', 'Create', 'Add', 'New', 'New Address'].some(t => aria.includes(t) || title.includes(t))) return el;
  }

  // Icon-only fallback: pick the top-right icon button in the modal header area.
  const rootRect = root.getBoundingClientRect ? root.getBoundingClientRect() : { top: 0 };
  const iconButtons = candidates.filter(el => {
    if (!isVisible(el)) return false;
    const hasIcon = !!el.querySelector('svg, span.icon, i');
    const txt = textOf(el);
    if (txt && txt.length > 1) return false;
    if (!hasIcon) return false;
    const rect = el.getBoundingClientRect();
    return rect.top <= (rootRect.top + 260);
  });
  if (iconButtons.length) {
    const sorted = iconButtons
      .map(el => ({ el, rect: el.getBoundingClientRect() }))
      .sort((a, b) => a.rect.top - b.rect.top || b.rect.left - a.rect.left);
    return sorted[0].el;
  }

  return null;
}

function hasCreateForm(root = document) {
  const modal = root || document;
  const addEmailPanel = queryAllDeep('.Panel.AddEmailPage, .AddEmail-inputs', modal)
    .find(el => isVisible(el));
  const heading = queryAllDeep('h1, h2, h3, div, span', modal)
    .find(el => isVisible(el) && textMatch(el, ['创建新地址', 'Create New Address', 'Create new address', 'New Address']));
  const labelInput = findExactLabelInput(modal)
    || findInputByPlaceholder(['标签', 'label', 'Label', '名称', 'Name', '设置标签'], modal);
  const noteInput = findExactNoteTextarea(modal)
    || findInputByPlaceholder(['备注', 'note', 'Note', '描述', 'Description'], modal)
    || findTextarea(modal);
  const createBtn = findCreateButton(modal);
  const found = !!((addEmailPanel || heading) && labelInput && createBtn);
  if (found) {
    debugLog('检测到创建表单已打开', {
      heading: heading ? textOf(heading).slice(0, 40) : '',
      hasLabel: !!labelInput,
      hasNote: !!noteInput
    });
  }
  return found;
}

async function createAliasFlow(modalRoot) {
  ensureNotPaused();
  const root = modalRoot || findModalRoot() || document;

  // Step 2: 点击“+”
  ensureNotPaused();
  reportStep(2, 'running');
  let activeRoot = findModalRoot() || root;
  const formAlreadyOpen = hasCreateForm(activeRoot);
  if (!formAlreadyOpen) {
    debugLog('Step 2: 查找“+”按钮');
    const plusBtn = await waitFor(() => findPlusButton(activeRoot), 15000, 400);
    if (plusBtn) {
      debugLog('已找到“+”按钮，准备使用 debugger 真点击', { tag: plusBtn.tagName, className: plusBtn.className });
      await requestDebuggerClick(plusBtn, 'Add button');
      debugLog('已使用 debugger 点击“+”按钮');
    } else {
      debugLog('未找到 + 按钮，尝试用文本按钮进入创建页', {
        buttons: queryAllDeep('button, [role="button"]', activeRoot)
          .filter(el => isVisible(el))
          .slice(0, 8)
          .map(el => ({ text: textOf(el).slice(0, 40), className: el.className }))
      });
      const createBtn = await waitFor(() => findClickableByText(['Create', '创建', '新建', '生成', '创建电子邮件地址'], activeRoot), 8000, 400);
      if (!createBtn) throw new Error('未找到“创建/新建/+”入口');
      debugLog('已找到“创建”入口（文本按钮），准备点击', { text: textOf(createBtn).slice(0, 40) });
      await humanClick(createBtn);
      debugLog('已点击“创建”入口（文本按钮）');
    }
  }

  const formReady = await waitFor(() => {
    const modal = findModalRoot() || root;
    return hasCreateForm(modal);
  }, 12000, 300);

  if (!formReady) {
    debugLog('创建表单仍未就绪，尝试再次点击“+”按钮');
    const retryPlus = await waitFor(() => findPlusButton(findModalRoot() || root), 8000, 400);
    if (retryPlus) {
      await requestDebuggerClick(retryPlus, 'Add button retry');
      const retryReady = await waitFor(() => hasCreateForm(findModalRoot() || root), 12000, 400);
      if (!retryReady) throw new Error('创建表单未出现');
    }
  }
  reportStep(2, 'done');

  // Step 3: 填写标签，然后点击“创建电子邮件地址”
  ensureNotPaused();
  reportStep(3, 'running');
  activeRoot = findModalRoot() || root;
  debugLog('Step 3: 开始填写标签与备注');

  let labelWritten = false;
  let noteCleared = true;
  const maxLabelAttempts = 3;
  let lastLabelError = '';
  for (let attempt = 1; attempt <= maxLabelAttempts; attempt += 1) {
    const labelInput = await waitFor(
      () => findExactLabelInput(activeRoot)
        || findInputByKeywords(['标签', 'label', 'Label', '名称', 'Name', '设置标签'], activeRoot),
      4000,
      300
    );
    const noteInput = findExactNoteTextarea(activeRoot)
      || findInputByPlaceholder(['备注', 'note', 'Note', '描述', 'Description'], activeRoot)
      || findTextarea(activeRoot);
    if (labelInput) {
      const date = new Date();
      const label = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
      labelInput.focus();
      setNativeValue(labelInput, label);
      await humanDelay(200, 400);
      const currentVal = (labelInput.value || labelInput.textContent || '').trim();
      labelWritten = currentVal.includes(label);
      if (noteInput) {
        noteInput.focus();
        setNativeValue(noteInput, '');
        await humanDelay(150, 300);
        const currentNote = (noteInput.value || noteInput.textContent || '').trim();
        noteCleared = currentNote === '';
      } else {
        noteCleared = true;
      }
      debugLog('已填写时间标签，并清空备注', { label, labelWritten, noteCleared, attempt });
      if (labelWritten && noteCleared) break;
      lastLabelError = !labelWritten ? '标签写入失败' : '备注清空失败';
    } else {
      lastLabelError = '未找到标签输入框';
      debugLog('未找到标签输入框，准备重试', { attempt });
    }
    await humanDelay(300, 600);
    activeRoot = findModalRoot() || root;
  }
  if (!labelWritten || !noteCleared) {
    throw new Error(`表单填写失败：${lastLabelError}`);
  }

  const confirmBtn = await waitFor(() => findCreateButton(activeRoot), 12000, 500);
  if (confirmBtn) {
    debugLog('已找到“创建电子邮件地址”按钮，准备使用 debugger 真点击', { text: textOf(confirmBtn).slice(0, 40) });
    const isDisabled = confirmBtn.disabled || confirmBtn.getAttribute('aria-disabled') === 'true';
    if (isDisabled) {
      debugLog('创建按钮处于禁用状态，等待可用');
      await waitFor(() => {
        const btn = findCreateButton(activeRoot);
        if (!btn) return false;
        const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true' || /disabled|is-disabled/.test(String(btn.className));
        return !disabled;
      }, 8000, 300);
      debugLog('创建按钮已可用');
    }
    await requestDebuggerClick(confirmBtn, 'Create email address button');
    debugLog('已使用 debugger 点击“创建电子邮件地址”按钮');
  } else {
    debugLog('未找到“创建电子邮件地址”按钮');
    throw new Error('未找到创建按钮');
  }

  await humanDelay(600, 1200);
  const creationResult = await waitFor(() => {
    const modal = findModalRoot() || activeRoot;
    const errorMessage = extractCreateError(modal) || extractCreateError(document);
    if (errorMessage) {
      return { type: 'error', message: errorMessage };
    }
    const alias = extractEmailFromDialog(modal);
    if (alias) {
      return { type: 'alias', alias };
    }
    return null;
  }, 15000, 200);
  if (creationResult?.type === 'error') {
    debugLog('检测到创建失败提示，停止继续新增', { error: creationResult.message });
    throw new Error(creationResult.message);
  }
  const alias = creationResult?.alias || '';
  debugLog('已识别新生成的邮箱地址', { alias });
  if (!alias) throw new Error('未能识别生成的邮箱，请手动检查弹窗');
  reportStep(3, 'done');

  // Step 4: 点击“返回”
  ensureNotPaused();
  reportStep(4, 'running');
  const backBtn = await waitFor(() => {
    const modal = findModalRoot() || activeRoot;
    return findClickableByText(['返回', 'Back'], modal) || findClickableByText(['返回', 'Back']);
  }, 12000, 400);
  if (backBtn) {
    debugLog('Step 4: 找到“返回”按钮，准备点击');
    await humanClick(backBtn);
    debugLog('已点击“返回”按钮');
    await waitFor(() => {
      const modal = findModalRoot() || activeRoot;
      return !hasCreateForm(modal);
    }, 10000, 400);
    reportStep(4, 'done');
  } else {
    debugLog('未找到“返回”按钮，流程结束但未返回');
    reportStep(4, 'skipped');
  }
  return alias;
}

async function runExclusive(fn) {
  if (running) throw new Error('Automation already running');
  running = true;
  try {
    if (!location.host.includes('icloud.com') && !location.host.includes('apple.com')) {
      throw new Error('当前页不是 iCloud/Apple');
    }
    return await fn();
  } finally {
    running = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'HME_UI_CREATE') {
    runExclusive(async () => {
      debugLog('=== 开始 Hide My Email 自动化流程 ===', { href: location.href });
      const incoming = message?.settings || {};
      const loopCount = Math.max(1, Math.min(50, Number(message?.loopCount) || 1));
      const settings = {
        retryMax: Number.isFinite(incoming.retryMax) ? incoming.retryMax : DEFAULT_SETTINGS.retryMax,
        retryDelayMinMs: Number.isFinite(incoming.retryDelayMinMs) ? incoming.retryDelayMinMs : DEFAULT_SETTINGS.retryDelayMinMs,
        retryDelayMaxMs: Number.isFinite(incoming.retryDelayMaxMs) ? incoming.retryDelayMaxMs : DEFAULT_SETTINGS.retryDelayMaxMs,
      };
      const created = [];
      const failed = [];
      let lastError = null;
      for (let round = 1; round <= loopCount; round += 1) {
        ensureNotPaused();
        const maxAttempts = Math.min(Math.max(Math.floor(settings.retryMax), 1), 5);
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            ensureNotPaused();
            debugLog(`开始第 ${round} 次循环`, { round, attempt });
            await humanDelay(500, 1200);
            let modalRoot = null;
            if (round === 1) {
              modalRoot = await openHideMyEmailSection();
            } else {
              modalRoot = await waitFor(() => findModalRoot(), 8000, 400);
              if (!modalRoot) throw new Error('未检测到隐藏邮件弹窗');
            }
            const alias = await createAliasFlow(modalRoot);
            if (alias) {
              created.push(alias);
            }
            debugLog(`第 ${round} 次循环完成`, { alias });
            lastError = null;
            break;
          } catch (err) {
            if ((err?.message || String(err)) === 'paused') {
              debugLog('检测到暂停请求，立即结束当前批量新增');
              return {
                ok: true,
                alias: created[created.length - 1] || '',
                created,
                failed,
                requestedCount: loopCount,
                paused: true,
              };
            }
            lastError = err;
            reportStep(0, 'error', err?.message || String(err));
            debugLog('循环失败，准备重试', { round, attempt, error: err?.message || String(err) });
            const min = Math.min(settings.retryDelayMinMs, settings.retryDelayMaxMs);
            const max = Math.max(settings.retryDelayMinMs, settings.retryDelayMaxMs);
            await humanDelay(min, max);
          }
        }
        if (lastError) {
          const errorMessage = lastError?.message || String(lastError);
          failed.push({ index: round, error: errorMessage });
          break;
        }
      }

      debugLog('=== Hide My Email 自动化流程完成 ===', {
        createdCount: created.length,
        failedCount: failed.length,
      });
      return {
        ok: true,
        alias: created[created.length - 1] || '',
        created,
        failed,
        requestedCount: loopCount,
      };
    })
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (message?.type === 'HME_PING') {
    sendResponse({ ok: true, version: SCRIPT_VERSION, href: location.href });
    return true;
  }
  if (message?.type === 'HME_PAUSE') {
    paused = true;
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === 'HME_RESUME') {
    paused = false;
    sendResponse({ ok: true });
    return true;
  }
});
