-- Lab Kiosk: Comprehensive Customization & Dynamic Presets
-- Enables custom single-site lockdown target URLs, custom broadcast presets,
-- custom lock curtain announcements, and custom portal branding for diverse settings
-- (schools, colleges, universities, libraries, and public/private kiosks).

ALTER TABLE tenants ADD COLUMN default_lock_message TEXT NOT NULL DEFAULT 'Screens locked by the instructor. Please look to the front.';
ALTER TABLE tenants ADD COLUMN portal_title TEXT;
ALTER TABLE tenants ADD COLUMN portal_subtitle TEXT;
ALTER TABLE tenants ADD COLUMN portal_description TEXT;
ALTER TABLE tenants ADD COLUMN portal_footer TEXT;

CREATE TABLE IF NOT EXISTS broadcast_presets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_broadcast_presets_tenant ON broadcast_presets(tenant_id);
