/**
 * `/verify-phone?t=…`: the page an emailed phone verification link opens
 * (src/phone_link.ts). Firebase texts a code to the number on record, the owner
 * types it, and the page sends Firebase's ID token to `POST /api/verify-phone`.
 *
 * The number is fixed: a wrong number is corrected by replying to the email, not
 * here, so the link cannot be used to verify some other phone.
 */

import { escapeAttr, escapeHtml, escapeJson } from "./escape";
import { FONT_LINKS, rootTokensCss } from "./ui_tokens";
import { FAVICON_LINK_HTML } from "./seo";
import { FIREBASE_SDK_ORIGIN, FIREBASE_SDK_VERSION, FirebaseConfig } from "./phone_verify";

export interface VerifyPhonePageOptions {
  nonce: string;
  firebase: FirebaseConfig;
  token: string;
  organizationName: string;
  phone: string;
  maskedPhone: string;
  homeHref: string;
}

export function renderVerifyPhoneHtml(options: VerifyPhonePageOptions): string {
  const { nonce, firebase, token, organizationName, phone, maskedPhone, homeHref } = options;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="robots" content="noindex, nofollow">
  <title>Verify your phone number</title>
${FAVICON_LINK_HTML}${FONT_LINKS}
  <style>
${rootTokensCss()}
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: 24px 16px;
      font-family: var(--font-sans);
      background: var(--bg-base);
      color: var(--text-main);
      -webkit-font-smoothing: antialiased;
    }
    main {
      max-width: 460px;
      width: 100%;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-md);
      padding: 32px 28px;
    }
    h1 { font-size: 1.375rem; font-weight: 650; letter-spacing: -0.02em; margin: 0 0 10px; text-wrap: balance; }
    p { color: var(--text-muted); font-size: 0.9375rem; line-height: 1.6; margin: 0 0 16px; text-wrap: pretty; }
    strong { color: var(--text-main); }
    .phone { font-family: var(--font-mono); color: var(--text-main); font-size: 1rem; }
    label { display: block; font-size: 0.875rem; font-weight: 600; margin: 0 0 6px; }
    .row { display: flex; gap: 8px; }
    input {
      flex: 1;
      min-width: 0;
      min-height: 40px;
      padding: 0 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg-base);
      color: var(--text-main);
      font-family: var(--font-mono);
      font-size: 1rem;
      letter-spacing: 0.2em;
    }
    input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
    button, a.button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 40px;
      padding: 0 18px;
      border: 0;
      border-radius: var(--radius-sm);
      background: var(--accent);
      color: var(--accent-fg);
      font: inherit;
      font-weight: 600;
      font-size: 0.875rem;
      text-decoration: none;
      cursor: pointer;
    }
    button:hover, a.button:hover { background: var(--accent-hover); }
    button:disabled { opacity: 0.6; cursor: default; }
    #code-group { margin-top: 20px; }
    #status { min-height: 1.5em; margin: 16px 0 0; font-size: 0.875rem; }
    #status.error { color: var(--danger-text); }
    #done { text-align: center; }
  </style>
</head>
<body>
  <main>
    <div id="steps">
      <h1>Verify your phone number</h1>
      <p>We text a six-digit code to the number on record for <strong>${escapeHtml(organizationName)}</strong>:</p>
      <p class="phone">${escapeHtml(maskedPhone)}</p>
      <p>If this is not your number, reply to our email with the right one instead.</p>
      <button type="button" id="send">Text me a code</button>
      <div id="code-group" hidden>
        <label for="code">Six-digit code from the text message</label>
        <div class="row">
          <input type="text" id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="123456">
          <button type="button" id="verify">Verify</button>
        </div>
      </div>
      <p id="status" role="status" aria-live="polite"></p>
      <div id="recaptcha"></div>
    </div>
    <div id="done" hidden>
      <h1>Phone number verified</h1>
      <p>Thank you. Nothing more is needed. You can close this page.</p>
      <a class="button" href="${escapeAttr(homeHref)}">Go to Lab Kiosk</a>
    </div>
  </main>
  <script nonce="${escapeAttr(nonce)}">
    const FIREBASE = ${escapeJson(firebase)};
    const FIREBASE_SDK = ${escapeJson(`${FIREBASE_SDK_ORIGIN}/firebasejs/${FIREBASE_SDK_VERSION}`)};
    const PHONE = ${escapeJson(phone)};
    const TOKEN = ${escapeJson(token)};
    // The token stays in this page only: the address bar and history lose it.
    history.replaceState(null, '', location.pathname);

    const sendButton = document.getElementById('send');
    const verifyButton = document.getElementById('verify');
    const codeInput = document.getElementById('code');
    const statusLine = document.getElementById('status');
    let auth = null;
    let firebaseAuth = null;
    let verifier = null;
    let confirmation = null;

    function say(message, isError) {
      statusLine.textContent = message;
      statusLine.className = isError ? 'error' : '';
    }
    async function firebaseModules() {
      if (!auth) {
        const appModule = await import(FIREBASE_SDK + '/firebase-app.js');
        auth = await import(FIREBASE_SDK + '/firebase-auth.js');
        const app = appModule.initializeApp(FIREBASE);
        firebaseAuth = auth.initializeAuth(app, { persistence: auth.inMemoryPersistence });
      }
      return auth;
    }

    sendButton.addEventListener('click', async () => {
      sendButton.disabled = true;
      say('Sending a code...');
      try {
        const modules = await firebaseModules();
        if (!verifier) verifier = new modules.RecaptchaVerifier(firebaseAuth, 'recaptcha', { size: 'invisible' });
        confirmation = await modules.signInWithPhoneNumber(firebaseAuth, PHONE, verifier);
        document.getElementById('code-group').hidden = false;
        codeInput.focus();
        say('We texted a code. It can take a minute to arrive.');
        sendButton.textContent = 'Text a new code';
        setTimeout(() => { sendButton.disabled = false; }, 60000);
        return;
      } catch (err) {
        const code = err && err.code ? String(err.code) : '';
        say(
          code === 'auth/too-many-requests' ? 'Too many codes were asked for this number. Try again later, or reply to our email.'
          : code === 'auth/operation-not-allowed' ? 'We cannot text numbers in this country yet. Please reply to our email.'
          : code === 'auth/invalid-phone-number' ? 'The number on record cannot receive text messages. Please reply to our email with the right one.'
          : 'The text message could not be sent. Try again in a moment.',
          true
        );
        if (verifier) { verifier.clear(); verifier = null; }
      }
      sendButton.disabled = false;
    });

    verifyButton.addEventListener('click', async () => {
      const code = codeInput.value.trim();
      if (!confirmation || !/^[0-9]{6}$/.test(code)) {
        say('Enter the six-digit code from the text message.', true);
        return;
      }
      verifyButton.disabled = true;
      let phoneToken = '';
      try {
        const result = await confirmation.confirm(code);
        phoneToken = await result.user.getIdToken();
      } catch (err) {
        say(err && err.code === 'auth/code-expired' ? 'That code has expired. Text a new one.' : 'That code is not correct.', true);
        verifyButton.disabled = false;
        return;
      }
      say('Checking...');
      try {
        const res = await fetch('/api/verify-phone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN, phoneToken })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          say(data.error || 'The number could not be verified. Try again.', true);
          verifyButton.disabled = false;
          return;
        }
        document.getElementById('steps').hidden = true;
        document.getElementById('done').hidden = false;
      } catch (err) {
        say('We could not reach Lab Kiosk. Check your connection and try again.', true);
        verifyButton.disabled = false;
      }
    });
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyButton.click(); });
  </script>
</body>
</html>`;
}
