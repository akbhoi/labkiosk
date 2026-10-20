# Admin Console Guide

The Operator Lab Dashboard is available at `https://<your-organization>.labkiosk.<platform-domain>/admin`, or `/admin` on your organization's custom domain.

Sign in with the account created when your organization registered, or an operator account invited by an organization administrator. Everything is strictly scoped to your organization alone — cross-tenant access is rejected with `403 Forbidden`.

---

## 1. Navigation

The console has one narrow **navigation rail** down the left edge. It shows icons only; point at an icon (or reach it with the keyboard) to see its name.

1. **Workstations** (`/admin/workstations`)
2. **Apps & Web** (`/admin/apps-web`)
3. **Staff** (`/admin/staff`)
4. **Settings** (`/admin/settings`)

Your initial at the bottom of the rail opens the profile menu: your account, the password and two-factor shortcuts, the theme switch and sign-out. On a phone the rail becomes a drawer, opened from the menu button, with every name written out.

Everything else belongs to the page you are on: its view tabs, its filters and its actions sit above its content. A button that is waiting for the server shows a spinner until the answer arrives.

---

## 2. Workstations Module (`/admin/workstations`)

### The Fleet Grid & Group Sections

Every enrolled workstation appears as a live telemetry card refreshed from `/api/clients`:

- **Thumbnail**: A JPEG screen capture from the last heartbeat (at most 3 seconds old; dropped if over 256 KB).
- **Online Indicator**: Derived from `last_seen`; stale after 20 seconds.
- **Active URL**: Where the machine is currently pointing.
- **Lock State**: Whether the fullscreen lock curtain is currently up.
- **Video**: What the workstation's graphics decode in hardware, from its last start: `Video: GPU · H.264, HEVC, VP9, AV1`, or `Video: CPU · NVIDIA graphics` / `Video: CPU only` in the warning colour when videos play on the processor. Point at the line for the driver and the full codec list. Nothing is shown until the workstation runs an agent that reports it.
- **Remote Control**: Opens the workstation's desktop through the console's relay; the workstation must be connected on its control channel. Only the organization's administrators (its owner and `org_admin` staff) see it; other staff do not.

Workstations in the main canvas are partitioned into collapsible **Group Sections** with headers, chevron collapse toggles, and group-wide selection checkboxes. Collapse states persist in `localStorage`.

### Workstation Groups

The **Groups** row above the toolbar manages groups:

- **`+ New group`**: Name and create a workstation group (e.g. *"Row 1"*, *"Lab A"*, *"Physics"*).
- **Group chips**: Filter the grid to one group, or to the ungrouped workstations, each with a live count. **All Workstations** in the row above shows everything again.
- **`✕` beside a group**: Deletes the group and leaves its workstations ungrouped.

### Light and Dark Theme

The console follows your device's light or dark setting. To use the other one, open the profile menu (your initial, bottom-left) and choose **Dark theme** or **Light theme**; the browser remembers the choice for this console. Choosing your device's own theme again returns to following the device.

### Selection Toolbar & Batch Commands

The top toolbar provides multi-device room operations:

- **Select All Toggle**: Select or deselect all visible workstations.
- **Dynamic Selection Counter**: Shows `# selected` in real time.
- **Targeted Action Buttons**:
  - **Lock**: Freeze selected screens with a custom message.
  - **Unlock**: Drop the lock curtain on selected machines.
  - **Broadcast URL**: Send selected machines to a specific page URL.
  - **Reset to Portal**: Return selected machines to the user launcher.
  - **Move to Group...**: Assign selected workstations to a named group (shown once something is selected).
- **Session & Power menu** (right-hand end of the toolbar). These interrupt whoever is at the screen, so they sit one click further away:
  - **Clear Session**: Sign every user out without restarting. The browser restarts in a few seconds with all website sign-ins, cookies, history and cache removed, then reopens its assigned page. Unsaved work in open pages is lost.
  - **Reboot**: Safely restart selected thin clients.
  - **Shutdown**: Safely power off selected thin clients at the end of the day.
  - **Wake (n)**, at the top of the menu: switch on the selected (or, with none selected, every) workstation that is off. A workstation that is on at the same site sends it the Wake-on-LAN signal; a toast says how many were woken and why any others could not be (no workstation on at its site, no wired adapter, its network not known yet, or an agent too old to send the signal). The machines' firmware must allow Wake-on-LAN.

### Per-Workstation Card Commands

Individual cards offer targeted actions: **Lock / Unlock**, **Navigate**, **Reload**, **Reboot**, **Shutdown**, **Mute**, **Remote Control** (noVNC), and **Decommission** (revokes token). A workstation that is off shows **Wake** instead, which switches it on through a workstation that is on at the same site (needs the `workstations` permission).

---

## 3. Apps & Web Module (`/admin/apps-web`)

Consolidates portal apps, browser allowlists, and broadcast controls into a single 3-tab module:

**Preview User Portal**, beside the page title, opens `/home` in a new tab. The tab labels show how many portal apps and allowed domains there are.

### Tab 1: Broadcast (`?tab=broadcast`)

Push an authoritative page URL across the entire lab:

- **Active Page Card**: Displays current broadcast state and epoch. Workstations navigate immediately and remain locked to that URL root even after rebooting.
- **1-Click Broadcast from Portal Apps**: Instantly broadcast any pre-configured learning app.
- **Custom Page Presets & Shortcuts**: Save URLs used repeatedly (e.g. today's quiz, lab manual) for fast access.
- **Reset to Portal**: Clears broadcast state across the fleet.

### Tab 2: User Portal Apps (`?tab=portal`)

Curate approved application cards displayed on the User Portal (`/home`):

- **Card Fields**: Title, URL, Category (e.g. "Math & Science"), Emoji Icon, and Thumbnail image URL.
- **Automatic Allowlisting**: Adding an app automatically authorises its domain in the Chromium managed policy.
- **Interactive Grid**: Edit, preview, test, broadcast, or delete portal application cards.

### Tab 3: Domain Allowlist (`?tab=whitelist`)

Controls Chromium's enterprise managed URL policy (`URLAllowlist`):

- **Managed Policy Integration**: Workstations block all external domains by default; only approved domains and portal app hosts can be opened.
- **1-Click STEM Domain Packs**: Quick-add reputable educational suites (Khan Academy, PhET, Scratch, Wikipedia, NASA, etc.).
- **Immediate Propagation**: Allowlist updates are pushed on each 3-second heartbeat.

---

## 4. Staff Module (`/admin/staff`)

Allows organization administrators to delegate lab control to colleagues with granular permission scoping:

### Role Filtering

- **Role chips** (in the Staff Accounts header): Filter staff accounts by role (`All Roles`, `Operator`, `Assistant`, `Content Manager`, `Co-Administrator`, plus dynamic roles) with real-time count badges.

### Invite & Create Operator Account

- **Accessible Form Elements**: Custom `.form-checkbox` and `.form-checkbox-label` components with crisp SVG tick marks and keyboard accessibility.
- **Role Presets**: Selecting a role automatically preselects appropriate permission checkboxes:
  - `workstations`: Control thin clients, lock screens, and reboot/shutdown.
  - `apps-web`: Manage broadcasts, user portal apps, and domain allowlists.
  - `staff`: Invite and manage other staff members.
  - `settings`: Modify organization identity, kiosk modes, and network parameters.
  - `updates`: Choose the update channel, (minor updates and security fixes always install at the next restart; a new major version waits to be confirmed, then installs at the next restart), and whether workstations share updates on the local network; ask for a new major release, try it on one workstation group, then confirm it for every workstation; and check for or install system updates on workstations.

---

## 5. Settings Module (`/admin/settings`)

Structured into semantic, deep-linkable tab panes (`?tab=...`) with horizontal 2-column card grouping (`grid-2col`):

### 1. General & Kiosk (`?tab=general`)

- **Organization & Kiosk Profile**: Organization/Lab Name, Display Mode (`portal` launcher vs `single_url` direct lockdown), Direct Lockdown URL, and Default Lock Message.
- **Kiosk Routing & Home URL**: Set default landing path (`/` organization homepage vs `/home` app grid) upon boot and reset.

### 2. Domains & Network (`?tab=domains`)

- **Organization Subdomain Customization**: Subdomain slug customization.
- **White-Label Custom Domain**: Request binding a custom FQDN (e.g. `kiosk.example.com`) with CNAME instructions and status indicators.

### 3. Organization Homepage (`?tab=homepage`)

- **Homepage Identity & Welcome**: Organization headline, introductory mission text, and direct preview shortcut.
- **Content Blocks**: Dynamic announcements, resource links, and campus guidelines (up to 12 custom cards).

### 4. Security & Audit (`?tab=security`)

- **Workstation Enrollment Key**: View, reveal, or rotate the enrollment key used to pair new thin clients. The key's last character checks the rest, so a workstation catches a typing mistake before it sends anything.
- **Account Security & Password**: Change admin password; revokes all other active sessions upon completion.
- **Single sign-on**: let staff sign in with **Continue with Google** (Google Workspace) or **Continue with Microsoft** (Microsoft Entra ID) on the organization's sign-in page. Turn each provider on and list who may use it: your Workspace domains (one per line, e.g. `example.org`; personal Gmail accounts never qualify) or your Entra tenant IDs (Microsoft Entra admin center → Overview → Tenant ID). The address the provider verifies must already belong to a staff account here (add people under Staff first): nobody is created by signing in, and the second factor your organization requires is still asked for. **Require single sign-on for staff** stops staff signing in with a password; the owner always can, so nobody is locked out, and passwords work again if the platform stops offering the providers you chose. Everyone with **Settings** sees the card; only the owner and co-administrators can change it, and every change is in Recent Activity. A provider the platform has not set up yet shows as such and cannot be turned on. List only directories your organization runs: whoever administers a listed directory decides which email address each of its accounts carries.
- **Recent Activity (`.table-scrollable`)**:
  - Administrative audit log of privileged actions, timestamps, and actors.
  - Capped with `.table-scrollable` (`max-height: 480px; overflow-y: auto;`) and sticky table headers (`th` pinned with `position: sticky; top: 0; z-index: 2;`).
  - Stays compact and neatly aligned with the left column cards.

### Two-factor sign-in (`?tab=two-factor`)

How your own account signs in. Every staff account can open Settings for this tab, whatever its permissions; without the `settings` permission it is the only tab shown.

- **Emailed code**: turn it on and every sign-in asks for a six-digit code sent to your address. Nothing to set up. The organization's owner and staff with the `org_admin` role always have it and cannot turn it off.
- **Authenticator app**: optional. Sign-in then asks for the app's code (an emailed one stays available), and you get ten recovery codes.
- **Passkeys**: optional, up to ten. Sign-in then offers **Use your passkey** first (a touch or fingerprint on this computer, your phone or a security key); an emailed code stays available. A passkey cannot be used on a fake copy of the site. One made on the organization's own domain works only there.

### Usage (`?tab=usage`)

How much the workstations are switched on and in use, for the last 7 days to 12 months (requires `settings`). A workstation is *in use* while someone has used its keyboard, mouse or touchscreen in the last minute; days are each workstation's own calendar days. Workstations report every 15 minutes, and reports are kept 400 days.

- **Tiles**: workstations used, hours in use, hours switched on, the share of switched-on time in use, and sessions (each start and each session clear).
- **Chart**: hours in use per day; hover or tap a bar for the figures.
- **Workstations**, **Sites** and **By day** tables, each with **Download CSV**.
- **Record the sites workstations visit**: on by default. Sites are recorded by hostname only, never the full address, the page, or who was at the workstation. Turned off, workstations stop sending them at once; **Delete recorded sites** removes what was already recorded.

Anonymous totals across every organization, never naming one, are also kept for the platform's own administrators (see the [Privacy Policy](https://labkiosk.org/privacy)).

Each workstation card also shows the machine it runs on (maker, model, memory and boot mode; CPU, keyboard, touchscreen and network addresses on hover), as its agent reports at every start.

### 5. Errors & Warnings (`?tab=issues`)

Problems workstations reported themselves, kept apart from Recent Activity (which records what people did) and deleted after 90 days. These are the outcomes of a system image update on an installed workstation, sent by the agent to `POST /api/devices/boot-report`, restarts that happened without a shutdown, sent to `POST /api/devices/restart-report`, and disks wearing out or failing, sent to `POST /api/devices/disk-health`:

| Problem | Severity | Meaning |
| :--- | :--- | :--- |
| **Update failed** | Error | The new image started but failed its health check on that first boot; the workstation restarts into the previous image. |
| **Update rolled back** | Error | The new image used its one try without being confirmed; the workstation is back on the previous image. |
| **Started a fallback image** | Warning | The image it should have started is missing or damaged, so GRUB started another one. |
| **Boot record error** | Error | The boot record could not be read or written; the details say why. |
| **Restarted without shutting down** | Warning | The workstation lost power, was switched off at the button, hung or crashed, and started again. |
| **Stopped responding** | Error | The workstation hung and its hardware watchdog restarted it. |
| **Disk wearing out or failing** | Warning, or Error when failing | The workstation's own disk reports wear or faults (SMART, or an eMMC card's wear figures), e.g. *Disk Example SSD 256GB (nvme0n1): Wearing out: 93% of its rated life used. Plan to replace it.* A failing disk ends *Replace it before it stops working.* Each disk is listed once per state, and never sent as an automatic bug report. |

A workstation that switched itself off by a power schedule but could not set its hardware clock to switch on again shows **Cannot switch itself on** (warning): the machine has no RTC that can wake it, or the RTC refused the alarm. Switch it on by hand or with **Wake**, and check the firmware's power settings.

Each row shows when the workstation recorded it (its own clock), the workstation and image version, and the details. A restart carries the end of the workstation's system log from before it: **Show log** opens it. Logs are cleared after 30 days and are never sent with automatic bug reports.

**Automatic bug reports (opt-in).** When the platform has set them up, the card offers **Send automatic bug reports**. To turn it on, tick **I accept the Automatic Bug Report Terms** (`/terms/bug-reports`) and then the option itself. From then on, new errors and warnings are filed as GitHub issues in the repository the hint names, where anyone may be able to read them. A report carries the kind of problem, the image version and the problem text with network addresses, host names and identifiers removed; never the organization's or its workstations' names. Problems listed before you turned it on are not sent. If the terms change, nothing is sent until you tick the box again to accept the new version. Untick the option to stop. When the platform has not set them up, the hint says so and the option cannot be turned on.

Under each problem, the report line shows where it stands:

- **Bug report queued**: waiting for the hourly run that files it.
- **New bug report #N**: it opened GitHub issue #N.
- **Already reported #N**: it matched an issue already filed, which received a comment instead.
- A badge with that issue's status on GitHub: **In progress** (assigned or labelled "in progress"), **PR created** (a pull request references it, with a **View PR** link), **Resolved** (closed as completed) or **Closed** (closed for another reason). An open issue shows no badge.

### Power (`?tab=power`)

Power schedules switch the organization's workstations off at the end of the day and, optionally, on again in the morning. Viewing and changing them needs the `settings` permission.

- **Add a schedule**: choose who it is for (**Every workstation** or one group), the days, the **Switch off at** time and, optionally, **Switch on at**. Times are each workstation's own clock (the time zone set in its Language & Region step).
- **The rule when schedules overlap**: on each day, a workstation follows its group's schedule for that day when there is one; otherwise the schedule for every workstation. Two schedules for the same workstations cannot share a day, and switch-on is at least 15 minutes from switch-off.
- **At the switch-off time** the workstation shows a five-minute warning with a countdown, then shuts down cleanly. A system update that is installing is never interrupted: the shutdown waits for it, and is picked up again after the update's restart. A workstation switched on after its switch-off time stays on until the next one.
- **Switch-on** is set in the workstation's hardware clock just before it shuts down. A machine that cannot be set reports **Cannot switch itself on** under Errors & Warnings. The firmware must allow waking from the RTC (often *Wake on RTC* or *Resume by alarm*), and the machine must keep power.
- Every change is recorded in Recent Activity and reaches the workstations at once.

### Printing (`?tab=printing`)

Printing is **off for every organization** until an administrator with the `settings` permission turns it on here. While it is off, no workstation runs a print service, Chromium refuses to print and the kiosk bar shows no Print button.

- **Allow workstations to print**: the switch. Turning it off keeps the printer list for next time.
- **Printers** (up to 20): for each, a **name** users see in the print dialog, its **address** and **For**, which is *Every workstation* or one workstation group. Only the workstations in that group get a printer limited to it; moving a workstation into or out of the group reaches it at once.
- **Address**: `ipp://` or `ipps://`, the printer's host name or private IP address (10.x, 172.16-31.x, 192.168.x, 169.254.x or an IPv6 unique local address), an optional port and a path, e.g. `ipp://192.168.1.40/ipp/print` or `ipps://printer.example.org/ipp/print`. Other kinds of address (`file:`, `usb:`, `socket:`, `lpd:`, `http:`), public IP addresses, the workstation itself, user names, query strings and spaces are refused. Every printer must support **IPP Everywhere** (driverless printing, which most network printers made since 2015 do, often called AirPrint or Mopria): there are no printer drivers on the workstation.
- **Save printing settings** records the change in Recent Activity (`settings.printing`) and sends it to the workstations straight away.

On each workstation the agent then sets up one print queue per printer, asking the printer itself for its capabilities, so a printer that is switched off or not reachable from that network is left out and tried again every 5 minutes. About six seconds after the first printer is ready, the kiosk bar shows **Print** and **Ctrl+P** prints the page; the print preview lists only these printers (never "Save as PDF"). Queues and jobs live in memory and are rebuilt at every start. A group deleted after a printer was limited to it leaves that printer showing **(group deleted)**: it reaches no workstation until it is set to another group or to every workstation.

---

## 6. Room Recipes

- **Starting an Assessment**:
  1. In `Apps & Web → Broadcast`, enter the assessment URL and click Broadcast.
  2. In `Workstations`, click **Select All** &rarr; **Lock** with instructions while handing out assessment materials.
  3. When all users are seated, click **Unlock**.
- **Regaining Attention**:
  1. Click **Lock** on the selection toolbar with a brief message (*"Eyes to the front please"*).
  2. Keystrokes, mouse clicks, and shortcuts are suppressed until unlocked.
- **End of a Session** (before the next group sits down):
  1. Click **Select All** on the Workstations toolbar (or select one group's checkbox).
  2. Open **Session & Power**, choose **Clear Session** and confirm.
  3. Within a few seconds every browser restarts signed out: no Google or organization-portal login, history, cookies or cached pages from the previous session remain. The machines stay on, so the next group starts immediately.
- **End of Day Lab Shutdown**:
  1. Click **Select All** on the Workstations toolbar.
  2. Open **Session & Power** and choose **Shutdown**.
  3. All thin clients power down cleanly. RAM overlay (`overlayroot="tmpfs"`) ensures browser histories, downloads, and temporary files reset 100% on the next boot.
