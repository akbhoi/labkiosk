/**
 * Public SaaS Landing Page & Authentication UI
 * Features product overview, ISO download instructions, school registration, and login.
 */

export function renderLandingHtml(data?: { error?: string; registered?: boolean }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lab Kiosk OS - Centralized School Computer Lab Management</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --panel: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --green: #10b981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; overflow-x: hidden; }
    header {
      padding: 20px 48px; display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1px solid rgba(51, 65, 85, 0.5); background: rgba(15, 23, 42, 0.7); backdrop-filter: blur(12px);
      position: sticky; top: 0; z-index: 100;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-logo {
      width: 40px; height: 40px; background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
      border-radius: 10px; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 14px rgba(59, 130, 246, 0.4);
    }
    .brand-title { font-size: 20px; font-weight: 800; letter-spacing: -0.3px; }
    .nav-actions { display: flex; align-items: center; gap: 14px; }
    .btn {
      padding: 9px 18px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer;
      text-decoration: none; transition: all 0.2s ease; display: inline-flex; align-items: center; gap: 8px;
    }
    .btn-ghost { background: transparent; color: var(--text); border: 1px solid var(--border); }
    .btn-ghost:hover { background: rgba(255, 255, 255, 0.05); }
    .btn-primary { background: var(--accent); color: #fff; border: 1px solid var(--accent); }
    .btn-primary:hover { background: var(--accent-hover); }

    /* Hero Section */
    .hero {
      padding: 90px 24px 60px; text-align: center; max-width: 900px; margin: 0 auto;
    }
    .hero-badge {
      display: inline-flex; align-items: center; gap: 8px; background: rgba(59, 130, 246, 0.12);
      border: 1px solid rgba(59, 130, 246, 0.3); color: #93c5fd; padding: 6px 16px; border-radius: 24px;
      font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 24px;
    }
    .hero-title {
      font-size: 56px; font-weight: 800; line-height: 1.15; letter-spacing: -1.5px; margin-bottom: 20px;
    }
    .hero-title span {
      background: linear-gradient(135deg, #60a5fa 0%, #a78bfa 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .hero-desc {
      font-size: 18px; color: var(--muted); line-height: 1.6; max-width: 720px; margin: 0 auto 36px;
    }
    .hero-ctas { display: flex; align-items: center; justify-content: center; gap: 16px; flex-wrap: wrap; }

    /* Features Grid */
    .features {
      padding: 60px 24px 90px; max-width: 1200px; margin: 0 auto; width: 100%;
    }
    .section-header { text-align: center; margin-bottom: 48px; }
    .section-title { font-size: 32px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 12px; }
    .section-sub { font-size: 16px; color: var(--muted); }
    .features-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 24px;
    }
    .feature-card {
      background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: 32px;
      transition: all 0.2s ease;
    }
    .feature-card:hover { border-color: #3b82f6; transform: translateY(-4px); }
    .feature-icon {
      width: 48px; height: 48px; background: rgba(59, 130, 246, 0.1); border-radius: 12px;
      display: flex; align-items: center; justify-content: center; color: #60a5fa; margin-bottom: 20px;
    }
    .feature-title { font-size: 18px; font-weight: 700; margin-bottom: 10px; }
    .feature-desc { font-size: 14px; color: var(--muted); line-height: 1.6; }

    /* Auth Modals */
    .modal-overlay {
      position: fixed; inset: 0; background: rgba(9, 13, 22, 0.85); backdrop-filter: blur(8px);
      display: none; align-items: center; justify-content: center; z-index: 1000; padding: 20px;
    }
    .modal-overlay.active { display: flex; }
    .modal-box {
      background: var(--panel); border: 1px solid var(--border); border-radius: 20px; padding: 40px;
      max-width: 460px; width: 100%; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8);
      position: relative;
    }
    .modal-close {
      position: absolute; top: 20px; right: 20px; background: transparent; border: none;
      color: var(--muted); cursor: pointer; font-size: 20px;
    }
    .modal-title { font-size: 24px; font-weight: 800; margin-bottom: 8px; }
    .modal-sub { font-size: 14px; color: var(--muted); margin-bottom: 24px; }
    .form-group { margin-bottom: 18px; }
    .form-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    .form-input {
      width: 100%; background: #1e293b; border: 1px solid var(--border); border-radius: 8px;
      padding: 11px 14px; color: #fff; font-size: 14px; outline: none; transition: border 0.15s ease;
    }
    .form-input:focus { border-color: var(--accent); }
    .input-hint { font-size: 11px; color: var(--muted); margin-top: 5px; }
    .modal-btn-submit {
      width: 100%; background: var(--accent); border: none; color: #fff; padding: 12px;
      border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; margin-top: 10px;
    }
    .modal-btn-submit:hover { background: var(--accent-hover); }
    .modal-switch { text-align: center; margin-top: 18px; font-size: 13px; color: var(--muted); }
    .modal-switch a { color: #60a5fa; text-decoration: none; cursor: pointer; }
    .alert-box {
      background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171;
      padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 18px; display: none;
    }
    footer {
      text-align: center; padding: 32px; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted);
      margin-top: auto;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-logo">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      </div>
      <div class="brand-title">Lab Kiosk</div>
    </div>
    <div class="nav-actions">
      <button class="btn btn-ghost" onclick="openModal('login-modal')">Sign In</button>
      <button class="btn btn-primary" onclick="openModal('register-modal')">Register School Lab</button>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="hero-badge">100% Free & Open Source Platform</div>
      <h1 class="hero-title">Centralized School Computer Lab <span>Kiosk Operating System</span></h1>
      <p class="hero-desc">
        Empower teachers with 100% remote monitoring, instant classroom lockdown, and zero SSD wear. Turn any thin client or desktop into an unhackable educational terminal managed right from your laptop.
      </p>
      <div class="hero-ctas">
        <button class="btn btn-primary" style="padding: 12px 28px; font-size: 16px;" onclick="openModal('register-modal')">
          Register Your School
        </button>
        <button class="btn btn-ghost" style="padding: 12px 28px; font-size: 16px;" onclick="openModal('iso-modal')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download Kiosk ISO
        </button>
      </div>
    </section>

    <section class="features">
      <div class="section-header">
        <h2 class="section-title">Engineered for School Computer Labs</h2>
        <p class="section-sub">Zero maintenance, total control, and zero student tampering.</p>
      </div>
      <div class="features-grid">
        <div class="feature-card">
          <div class="feature-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <h3 class="feature-title">Zero SSD Wear (RAM Overlay)</h3>
          <p class="feature-desc">All disk writes are strictly directed to volatile RAM via <code>overlayroot="tmpfs"</code>. Protects thin-client SSDs from wearing out and erases student files on every reboot.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <h3 class="feature-title">Instant Eyes-Front Lock</h3>
          <p class="feature-desc">One click covers all classroom screens with a fullscreen curtain requiring student attention. Unlocks instantly when you are ready to resume teaching.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 16 21 12 17"/></svg>
          </div>
          <h3 class="feature-title">Live Grid & Remote Control</h3>
          <p class="feature-desc">Live screen thumbnails update every 3 seconds on your dashboard. Click any workstation to instantly take interactive keyboard and mouse control via noVNC.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
          </div>
          <h3 class="feature-title">Custom School Subdomains</h3>
          <p class="feature-desc">Every school gets its own custom subdomain (e.g. <code>greenwood.labkiosk.io</code>). Thin clients connect separately and remain 100% isolated to your school's private dashboard.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          </div>
          <h3 class="feature-title">Visual Student App Launcher</h3>
          <p class="feature-desc">Admins configure cards with custom thumbnails for allowed educational websites (Khan Academy, Scratch, CK-12, GeoGebra). Students easily launch approved apps.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          </div>
          <h3 class="feature-title">Auto-Hiding Floating Navigation</h3>
          <p class="feature-desc">The 4-button locked navigation bar hides off-screen and smoothly slides down only when moving the mouse to the top edge, ensuring zero webpage overflow.</p>
        </div>
      </div>
    </section>
  </main>

  <!-- Login Modal -->
  <div class="modal-overlay" id="login-modal">
    <div class="modal-box">
      <button class="modal-close" onclick="closeModal('login-modal')">✕</button>
      <h2 class="modal-title">Teacher & Admin Sign In</h2>
      <p class="modal-sub">Log in to manage your school computer lab.</p>
      <div class="alert-box" id="login-alert"></div>
      <form id="login-form">
        <div class="form-group">
          <label class="form-label">Email Address</label>
          <input type="email" class="form-input" id="login-email" required placeholder="teacher@school.edu">
        </div>
        <div class="form-group">
          <label class="form-label">Password</label>
          <input type="password" class="form-input" id="login-password" required placeholder="••••••••">
        </div>
        <button type="submit" class="modal-btn-submit">Sign In to Lab Console</button>
      </form>
      <div class="modal-switch">
        New school? <a onclick="switchModal('login-modal', 'register-modal')">Register your lab</a>
      </div>
    </div>
  </div>

  <!-- Register Modal -->
  <div class="modal-overlay" id="register-modal">
    <div class="modal-box">
      <button class="modal-close" onclick="closeModal('register-modal')">✕</button>
      <h2 class="modal-title">Register Your School Lab</h2>
      <p class="modal-sub">Claim your free custom subdomain and cloud console.</p>
      <div class="alert-box" id="register-alert"></div>
      <form id="register-form">
        <div class="form-group">
          <label class="form-label">School / Organization Name</label>
          <input type="text" class="form-input" id="reg-name" required placeholder="Greenwood High School">
        </div>
        <div class="form-group">
          <label class="form-label">Teacher / Admin Email</label>
          <input type="email" class="form-input" id="reg-email" required placeholder="teacher@greenwood.edu">
        </div>
        <div class="form-group">
          <label class="form-label">Password</label>
          <input type="password" class="form-input" id="reg-password" required minlength="8" placeholder="••••••••">
        </div>
        <div class="form-group">
          <label class="form-label">Requested Subdomain Slug</label>
          <div style="display: flex; align-items: center; gap: 6px;">
            <input type="text" class="form-input" id="reg-subdomain" required placeholder="greenwood" pattern="[a-z0-9\-]+" style="font-family: monospace;">
            <span style="font-family: monospace; font-size: 13px; color: var(--muted); white-space: nowrap;">.labkiosk.io</span>
          </div>
          <div class="input-hint">Lowercase letters, numbers, hyphens only. Subject to super admin approval.</div>
        </div>
        <button type="submit" class="modal-btn-submit">Register Lab & Request Subdomain</button>
      </form>
      <div class="modal-switch">
        Already registered? <a onclick="switchModal('register-modal', 'login-modal')">Sign in</a>
      </div>
    </div>
  </div>

  <!-- ISO Download Modal -->
  <div class="modal-overlay" id="iso-modal">
    <div class="modal-box" style="max-width: 540px;">
      <button class="modal-close" onclick="closeModal('iso-modal')">✕</button>
      <h2 class="modal-title">Download Lab Kiosk ISO</h2>
      <p class="modal-sub">Flash to a USB drive and boot any PC or Thin Client.</p>
      <div style="background: #1e293b; border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px;">
        <h4 style="font-size: 14px; margin-bottom: 8px; color: #60a5fa;">Step 1: Write ISO to USB</h4>
        <p style="font-size: 13px; color: var(--muted); line-height: 1.5; margin-bottom: 14px;">
          Download the latest <code>labkiosk-debian12-amd64.iso</code> (approx 750 MB) and write it to a USB drive using <strong>Rufus</strong> (Windows) or <strong>balenaEtcher</strong> (Mac/Linux).
        </p>
        <h4 style="font-size: 14px; margin-bottom: 8px; color: #60a5fa;">Step 2: Boot Client & First-Boot Wizard</h4>
        <p style="font-size: 13px; color: var(--muted); line-height: 1.5;">
          Boot your PC from the USB. The first-boot wizard will prompt you to enter your <strong>School Subdomain</strong> and <strong>Computer Name (e.g. PC-01)</strong>. Once entered, the PC permanently connects to your cloud dashboard!
        </p>
      </div>
      <a href="https://github.com" target="_blank" class="modal-btn-submit" style="text-align: center; display: block; text-decoration: none;">
        Download Latest Release (.ISO)
      </a>
    </div>
  </div>

  <footer>
    Lab Kiosk OS • Engineered for School Computer Labs Worldwide
  </footer>

  <script>
    function openModal(id) {
      document.getElementById(id).classList.add('active');
    }
    function closeModal(id) {
      document.getElementById(id).classList.remove('active');
    }
    function switchModal(closeId, openId) {
      closeModal(closeId);
      openModal(openId);
    }

    // Login Submission
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      const alertBox = document.getElementById('login-alert');
      alertBox.style.display = 'none';

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (data.status === 'ok') {
          if (data.role === 'super_admin') {
            window.location.href = '/super';
          } else if (data.subdomain) {
            window.location.href = '/admin?tenant=' + data.subdomain;
          } else {
            window.location.href = '/admin';
          }
        } else {
          alertBox.textContent = data.error || 'Login failed';
          alertBox.style.display = 'block';
        }
      } catch (err) {
        alertBox.textContent = 'Network error during login';
        alertBox.style.display = 'block';
      }
    });

    // Register Submission
    document.getElementById('register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('reg-name').value.trim();
      const email = document.getElementById('reg-email').value.trim();
      const password = document.getElementById('reg-password').value;
      const subdomain = document.getElementById('reg-subdomain').value.trim().toLowerCase();
      const alertBox = document.getElementById('register-alert');
      alertBox.style.display = 'none';

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password, subdomain })
        });
        const data = await res.json();
        if (data.status === 'ok') {
          alert('Registration successful! Subdomain request submitted. Logging in...');
          if (data.subdomain) {
            window.location.href = '/admin?tenant=' + data.subdomain;
          } else {
            window.location.href = '/admin';
          }
        } else {
          alertBox.textContent = data.error || 'Registration failed';
          alertBox.style.display = 'block';
        }
      } catch (err) {
        alertBox.textContent = 'Network error during registration';
        alertBox.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
}
