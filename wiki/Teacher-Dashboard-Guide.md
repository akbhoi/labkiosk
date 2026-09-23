# Teacher Dashboard Guide

The Teacher Lab Dashboard is available at `https://<your-school>.labkiosk.<platform-domain>/admin`, or `/admin` on your school's custom domain.

Sign in with the account created when your school registered, or an instructor account invited by a school administrator. Everything is strictly scoped to your school alone — cross-tenant access is rejected with `403 Forbidden`.

---

## 1. Unified Navigation Architecture

The Teacher Lab Console features a unified **Left-Side Multi-Level Panels Architecture**:

- **Level 1 (Primary Rail — 72px)**: Slim, persistent vertical bar with brand glyph, primary module navigation, live stats badge, bottom-left profile avatar button with anchored menu (user details, role badge, password/settings shortcut, and POST sign-out), and sidebar collapse toggle.
  1. 🖥️ **Workstations** (`/admin/workstations`)
  2. 🌐 **Apps & Web** (`/admin/apps-web`)
  3. 👥 **Teachers & Staff** (`/admin/teachers`)
  4. ⚙️ **Lab Settings** (`/admin/settings`)
- **Level 2 (Secondary Action Panel — 272px)**: Contextual tools, live filters, workstation groups, and quick actions designed to stay stable without unexpected layout shifting.

---

## 2. Workstations Module (`/admin/workstations`)

### The Fleet Grid & Group Sections
Every enrolled workstation appears as a live telemetry card refreshed from `/api/clients`:
- **Thumbnail**: A JPEG screen capture from the last heartbeat (at most 3 seconds old; dropped if over 256 KB).
- **Online Indicator**: Derived from `last_seen`; stale after 20 seconds.
- **Active URL**: Where the machine is currently pointing.
- **Lock State**: Whether the fullscreen lock curtain is currently up.
- **Remote Control**: Enabled when the workstation reports a secure Cloudflare Tunnel host.

Workstations in the main canvas are partitioned into collapsible **Group Sections** with headers, chevron collapse toggles, and group-wide selection checkboxes. Collapse states persist in `localStorage`.

### Workstation Groups Management (Level 2 Sidebar)
The left subpanel is dedicated to group management:
- **`+ New Group`**: Prompt to name and create a new workstation group (e.g. *"Row 1"*, *"Lab A"*, *"Physics"*).
- **Group Filter List**: Filter the main canvas to view all machines or machines in a specific group, with live device count pills.
- **Delete Group**: Deletes a group and resets member devices to unassigned (`NULL`).

### Selection Toolbar & Batch Commands
The top toolbar provides multi-device classroom operations:
- **Select All Toggle**: Select or deselect all visible workstations.
- **Dynamic Selection Counter**: Shows `# selected` in real time.
- **Targeted Action Buttons**:
  - **Lock**: Freeze selected screens with a custom message.
  - **Unlock**: Drop the lock curtain on selected machines.
  - **Reboot**: Safely restart selected thin clients.
  - **Shutdown**: Safely power off selected thin clients at the end of the day.
  - **Move to Group...**: Assign selected workstations to a named group.
  - **Reset to Portal**: Return selected machines to the student launcher.
  - **Broadcast URL**: Send selected machines to a specific lesson URL.

### Per-Workstation Card Commands
Individual cards offer targeted actions: **Lock / Unlock**, **Navigate**, **Reload**, **Reboot**, **Shutdown**, **Mute**, **Remote Control** (noVNC), and **Decommission** (revokes token).

---

## 3. Apps & Web Module (`/admin/apps-web`)

Consolidates all curriculum content, browser allowlists, and broadcast controls into a single 3-tab module:

### Sidebar Subpanel (Level 2)
- **Static Tab Switchers**:
  - `📶 Lesson Broadcast` (`tab=broadcast`)
  - `⊞ Student Portal` (`tab=portal`, with live app count badge)
  - `🛡️ Domain Allowlist` (`tab=whitelist`, with domain count badge)
- **Quick Shortcut**: `Preview Student Portal &rarr;` (opens `/home` in a new tab).
- **Module Overview Card**: Persistent display of Total Portal Apps, Allowed Domains, and Live Broadcast Status.

### Tab 1: Lesson Broadcast (`?tab=broadcast`)
Push an authoritative lesson URL across the entire lab:
- **Active Lesson Card**: Displays current broadcast state and epoch. Workstations navigate immediately and remain locked to that URL root even after rebooting.
- **1-Click Broadcast from Portal Apps**: Instantly broadcast any pre-configured learning app.
- **Custom Lesson Presets & Shortcuts**: Save URLs used repeatedly (e.g. today's quiz, lab manual) for fast access.
- **Reset to Portal**: Clears broadcast state across the fleet.

### Tab 2: Student Portal Apps (`?tab=portal`)
Curate educational application cards displayed on the Student Portal (`/home`):
- **Card Fields**: Title, URL, Category (e.g. "Math & Science"), Emoji Icon, and Thumbnail image URL.
- **Automatic Allowlisting**: Adding an app automatically authorises its domain in the Chromium managed policy.
- **Interactive Grid**: Edit, preview, test, broadcast, or delete portal application cards.

### Tab 3: Domain Allowlist (`?tab=whitelist`)
Controls Chromium's enterprise managed URL policy (`URLAllowlist`):
- **Managed Policy Integration**: Workstations block all external domains by default; only approved domains and portal app hosts can be opened.
- **1-Click STEM Domain Packs**: Quick-add reputable educational suites (Khan Academy, PhET, Scratch, Wikipedia, NASA, etc.).
- **Immediate Propagation**: Allowlist updates are pushed on each 3-second heartbeat.

---

## 4. Teachers & Staff Module (`/admin/teachers`)

Allows school administrators to delegate lab control to colleagues with granular permission scoping:

### Role Filtering (Level 2 Sidebar)
- **Role Filters**: Filter staff accounts by role (`All Roles`, `Teacher`, `Lab Assistant`, `Content Manager`, `Co-Administrator`, plus dynamic roles) with real-time count badges.

### Invite & Create Teacher Account
- **Accessible Form Elements**: Custom `.form-checkbox` and `.form-checkbox-label` components with crisp SVG tick marks and keyboard accessibility.
- **Role Presets**: Selecting a role automatically preselects appropriate permission checkboxes:
  - `workstations`: Control thin clients, lock screens, and reboot/shutdown.
  - `apps-web`: Manage broadcasts, student portal apps, and domain allowlists.
  - `teachers`: Invite and manage other staff members.
  - `settings`: Modify school identity, kiosk modes, and network parameters.

---

## 5. Lab Settings Module (`/admin/settings`)

Structured into 4 semantic, deep-linkable tab panes (`?tab=...`) with horizontal 2-column card grouping (`grid-2col`):

### 1. General & Kiosk (`?tab=general`)
- **Institution & Kiosk Profile**: School/Lab Name, Display Mode (`portal` launcher vs `single_url` direct lockdown), Direct Lockdown URL, and Default Lock Message.
- **Kiosk Routing & Home URL**: Set default landing path (`/` school homepage vs `/home` app grid) upon boot and reset.

### 2. Domains & Network (`?tab=domains`)
- **School Subdomain & VNC Tunnel**: Subdomain slug customization and Cloudflare Tunnel hostname.
- **White-Label Custom Domain**: Request binding a custom FQDN (e.g. `kiosk.school.edu`) with CNAME instructions and status indicators.

### 3. School Homepage (`?tab=homepage`)
- **Homepage Identity & Welcome**: School headline, introductory mission text, and direct preview shortcut.
- **Content Blocks**: Dynamic announcements, resource links, and campus guidelines (up to 12 custom cards).

### 4. Security & Audit (`?tab=security`)
- **Workstation Enrollment Key**: View, reveal, or rotate the enrollment key used to pair new thin clients.
- **Account Security & Password**: Change admin password; revokes all other active sessions upon completion.
- **Recent Lab Activity (`.table-scrollable`)**:
  - Administrative audit log of privileged actions, timestamps, and actors.
  - Capped with `.table-scrollable` (`max-height: 480px; overflow-y: auto;`) and sticky table headers (`th` pinned with `position: sticky; top: 0; z-index: 2;`).
  - Stays compact and neatly aligned with the left column cards.

---

## 6. Classroom Recipes

- **Starting an Exam**:
  1. In `Apps & Web → Lesson Broadcast`, enter the exam URL and click Broadcast.
  2. In `Workstations`, click **Select All** &rarr; **Lock** with instructions while handing out exam materials.
  3. When all students are seated, click **Unlock**.
- **Regaining Class Attention**:
  1. Click **Lock** on the selection toolbar with a brief message (*"Eyes to the front please"*).
  2. Keystrokes, mouse clicks, and shortcuts are suppressed until unlocked.
- **End of Day Lab Shutdown**:
  1. Click **Select All** on the Workstations toolbar.
  2. Click **Shutdown**.
  3. All thin clients power down cleanly. RAM overlay (`overlayroot="tmpfs"`) ensures browser histories, downloads, and temporary files reset 100% on the next boot.
