/**
 * Student Educational Portal / App Launcher UI
 * Configurable card grid for approved educational websites.
 */

import { Tenant, PortalSite } from "./types";

export function renderPortalHtml(tenant: Tenant, sites: PortalSite[]): string {
  const cardsHtml = sites.map((site) => `
    <div class="app-card" onclick="window.location.href='${site.url}'">
      <div class="card-thumb" style="background-image: url('${site.thumbnail_url || "https://images.unsplash.com/photo-1509228468518-180dd4864904?w=600&q=80"}')">
        <span class="card-category">${site.category}</span>
      </div>
      <div class="card-body">
        <div class="card-header">
          <span class="card-icon">${site.icon || "🌐"}</span>
          <h3 class="card-title">${site.title}</h3>
        </div>
        <p class="card-domain">${site.domain}</p>
        <button class="launch-btn">
          <span>Launch App</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
      </div>
    </div>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${tenant.name} - Student Learning Portal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #090d16;
      --bg-surface: #0f172a;
      --bg-card: #1e293b;
      --border: #334155;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --green: #10b981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body {
      background: radial-gradient(circle at 50% 0%, #1e293b 0%, #090d16 80%);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      user-select: none;
      overflow-x: hidden;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 36px;
      background: rgba(15, 23, 42, 0.8);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .brand-icon {
      width: 42px;
      height: 42px;
      background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.35);
    }
    .brand-name {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.3px;
    }
    .brand-sub {
      font-size: 12px;
      color: var(--text-muted);
      font-weight: 500;
    }
    .header-meta {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .status-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      color: #34d399;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 8px var(--green);
    }
    .clock {
      font-family: 'JetBrains Mono', monospace;
      font-size: 14px;
      color: var(--text-muted);
      font-weight: 500;
    }
    main {
      flex: 1;
      padding: 40px 36px 60px;
      max-width: 1380px;
      width: 100%;
      margin: 0 auto;
    }
    .portal-hero {
      text-align: center;
      margin-bottom: 40px;
    }
    .portal-title {
      font-size: 32px;
      font-weight: 800;
      letter-spacing: -0.5px;
      margin-bottom: 10px;
    }
    .portal-desc {
      font-size: 16px;
      color: var(--text-muted);
      max-width: 600px;
      margin: 0 auto;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 24px;
    }
    .app-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
      cursor: pointer;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      flex-direction: column;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
    }
    .app-card:hover {
      transform: translateY(-6px);
      border-color: #3b82f6;
      box-shadow: 0 12px 30px rgba(59, 130, 246, 0.25);
    }
    .card-thumb {
      height: 150px;
      background-size: cover;
      background-position: center;
      position: relative;
      background-color: #1e293b;
    }
    .card-thumb::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(to top, rgba(30, 41, 59, 0.9) 0%, transparent 70%);
    }
    .card-category {
      position: absolute;
      top: 12px;
      left: 12px;
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(8px);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #93c5fd;
      border: 1px solid rgba(255, 255, 255, 0.1);
      z-index: 1;
    }
    .card-body {
      padding: 20px;
      display: flex;
      flex-direction: column;
      flex: 1;
      justify-content: space-between;
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
    }
    .card-icon {
      font-size: 20px;
    }
    .card-title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.3px;
    }
    .card-domain {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 18px;
    }
    .launch-btn {
      width: 100%;
      background: #0f172a;
      border: 1px solid var(--border);
      color: var(--text-main);
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.15s ease;
    }
    .app-card:hover .launch-btn {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }
    footer {
      text-align: center;
      padding: 24px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      font-size: 12px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      </div>
      <div>
        <div class="brand-name">${tenant.name}</div>
        <div class="brand-sub">Computer Lab Learning Portal</div>
      </div>
    </div>
    <div class="header-meta">
      <div class="status-pill">
        <div class="dot"></div>
        <span>Protected Kiosk Session</span>
      </div>
      <div class="clock" id="live-clock">--:--:--</div>
    </div>
  </header>

  <main>
    <div class="portal-hero">
      <h1 class="portal-title">Select an Educational Resource</h1>
      <p class="portal-desc">Click any approved application below to begin your lesson. All external access is filtered and managed by your teacher.</p>
    </div>

    <div class="grid">
      ${cardsHtml}
    </div>
  </main>

  <footer>
    Protected by Lab Kiosk OS • Educational Environment Restricted
  </footer>

  <script>
    function updateClock() {
      const now = new Date();
      document.getElementById('live-clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    setInterval(updateClock, 1000);
    updateClock();
  </script>
</body>
</html>`;
}
