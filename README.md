# Toggl Track Auto

🕐 Automatically track your time in Toggl based on your git branch and Monday.com tickets.

Built for the Pivot team, but works for anyone using Toggl + git!

## Features

- **Auto-tracks by git branch** — Starts a timer when you switch branches
- **Monday.com integration** — Fetches task names from Monday.com tickets (optional)
- **Idle detection** — Pauses tracking after configurable idle time
- **Status bar** — Shows current tracking status
- **Resume on activity** — Resumes tracking when you start typing again
- **Setup wizard** — Easy first-time configuration

## Installation

### From VSIX (Cursor / VS Code)

1. Download the latest `.vsix` from [Releases](../../releases)
2. Open Cursor/VS Code
3. Press `Ctrl+Shift+P` → **"Extensions: Install from VSIX..."**
4. Select the downloaded `.vsix` file
5. **Follow the setup wizard** that appears automatically

### From Source

```bash
git clone https://github.com/alexdeg92/toggl-track-vscode.git
cd toggl-track-vscode
npm install
npm run compile
npx vsce package --allow-missing-repository
```

## Setup

On first launch, a **setup wizard** will guide you through:

1. **Toggl API Token** — Get it from https://track.toggl.com/profile (scroll down)
2. **Monday.com Token** (optional) — For task name lookups

You can re-run setup anytime: `Ctrl+Shift+P` → **"Toggl: Setup"**

## How it works

```
You checkout: feat/4176868-acomba-export
        ↓
Extension detects branch change
        ↓
Extracts ticket ID: 4176868
        ↓
Queries Monday.com: "What's task 4176868?"
        ↓
Creates Toggl entry: "[4176868] Backend: Acomba temporary payroll format"
        ↓
Timer runs until you switch branches or go idle
```

## Branch naming convention

The extension looks for 6+ digit numbers in your branch name:

- ✅ `feat/4176868-acomba-export`
- ✅ `fix/4176868`
- ✅ `4176868-hotfix`
- ⚠️ `main` (no ticket ID → uses branch name as description)

## Commands

| Command | Description |
|---------|-------------|
| `Toggl: Setup` | Run the setup wizard |
| `Toggl: Start Tracking` | Start automatic tracking |
| `Toggl: Stop Tracking` | Stop tracking |
| `Toggl: Show Status` | Show current timer info |

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `togglTrackAuto.apiToken` | Your Toggl API token | - |
| `togglTrackAuto.workspaceId` | Your Toggl workspace ID | - |
| `togglTrackAuto.mondayApiToken` | Monday.com API token | - |
| `togglTrackAuto.branchPattern` | Regex for ticket ID | `(\d{6,})` |
| `togglTrackAuto.entryFormat` | Timer description format | `[{ticket_id}] {task_name}` |
| `togglTrackAuto.idleTimeoutMinutes` | Idle timeout | 5 |
| `togglTrackAuto.projectId` | Toggl project ID | 0 |
| `togglTrackAuto.enabled` | Enable auto-tracking | true |

## License

MIT © Pivot Studio Inc.
