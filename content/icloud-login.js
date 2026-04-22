// content/icloud-login.js — Auto-click the Sign In entry on iCloud landing pages.

console.log('[MultiPage:icloud-login] Content script loaded on', location.href);

const ICLOUD_SIGN_IN_WAIT_TIMEOUT = 20000;
let icloudSignInClicked = false;

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isVisible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findIcloudSignInButton() {
  const hostCandidates = Array.from(document.querySelectorAll('ui-button.sign-in-button, .sign-in-button[role="button"]'));
  for (const candidate of hostCandidates) {
    const label = normalizeText(candidate.textContent);
    if (isVisible(candidate) && (!label || /^(sign in|登录)$/.test(label))) {
      return candidate;
    }
  }

  const innerButtonCandidates = Array.from(document.querySelectorAll('ui-button.sign-in-button button[type="button"], .sign-in-button button[type="button"]'));
  for (const candidate of innerButtonCandidates) {
    const host = candidate.closest('ui-button.sign-in-button, .sign-in-button[role="button"]');
    const label = normalizeText(host?.textContent || candidate.textContent);
    if (isVisible(candidate) && (!label || /^(sign in|登录)$/.test(label))) {
      return host || candidate;
    }
  }

  return null;
}

async function autoClickIcloudSignIn() {
  if (window !== window.top) return;
  if (icloudSignInClicked || window.__MULTIPAGE_ICLOUD_SIGNIN_AUTO_CLICKED) return;

  try {
    await waitForDocumentReady('interactive', 10000);
  } catch (err) {
    console.warn('[MultiPage:icloud-login] Document was not ready in time:', err?.message || err);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < ICLOUD_SIGN_IN_WAIT_TIMEOUT) {
    const signInButton = findIcloudSignInButton();
    if (signInButton) {
      simulateClick(signInButton);
      icloudSignInClicked = true;
      window.__MULTIPAGE_ICLOUD_SIGNIN_AUTO_CLICKED = true;
      log('Auto-clicked iCloud Sign In button.', 'ok');
      return;
    }
    await sleep(200);
  }
}

autoClickIcloudSignIn().catch((err) => {
  console.warn('[MultiPage:icloud-login] Auto-click failed:', err?.message || err);
  log(`Auto-click iCloud Sign In failed: ${err?.message || err}`, 'warn');
});
