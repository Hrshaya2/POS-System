# Nangi POS - Automated Setup Guide

## What's Included

| File | Purpose |
|------|---------|
| `install.bat` | Double-click launcher. Self-elevates to Administrator, then runs `install.ps1`. |
| `install.ps1` | The main automation script. Handles everything: Node.js install, npm install, .env creation, server launch, logging. |
| `backend/.env.example` | Template for backend environment configuration. |
| `setup-log.txt` | Created automatically in the project root. Records every step and any errors. |

## How to Use

1. Copy the **entire POS folder** (including `install.bat`, `install.ps1`, `backend/`, `frontend/`) to a USB drive or zip it.
2. On the target machine, extract/copy the folder anywhere (e.g. `C:\POS`).
3. **Double-click `install.bat`**.
4. If Windows asks "Do you want to allow this app to make changes?", click **Yes** (this is the UAC elevation prompt).
5. The script runs automatically. It will:
   - Check for Node.js → install it silently if missing
   - Check for Git (informational only — not required)
   - Verify `backend/` and `frontend/` folders exist
   - Create `backend/.env` from `backend/.env.example` if missing
   - Run `npm install` in `backend/` and `frontend/`
   - Check ports 5000 and 5173
   - Ask if you want to launch the app now (y/n)
6. If you say **y**, it starts both servers and opens your browser to `http://localhost:5173`.

## Default Login Credentials

| Role | Email | Password |
|------|-------|----------|
| Admin | `admin@nangi.com` | `admin123` |
| Shop Owner | `shop@nangi.com` | `shop123` |
| Cashier | `cashier@nangi.com` | `cashier123` |

> **Note:** The first time you log in, the backend seeds these users automatically via the `/api/auth/seed` endpoint.

## Logging

Every step is written to **`setup-log.txt`** in the project root. If something goes wrong, send this file to the developer — it contains timestamps, versions, error messages, and the exact step that failed.

---

## Test Scenarios

### (a) Machine with NOTHING installed (no Node.js, no npm, no Git)

**What happens:**

1. User double-clicks `install.bat`.
2. UAC prompt appears → user clicks **Yes**.
3. `install.bat` detects it's not running as admin, relaunches itself elevated, then runs `install.ps1`.
4. Script checks for Node.js → **not found**.
5. Script checks internet connectivity to `nodejs.org` → **connected**.
6. Script checks if `msiexec` is busy → **not busy**.
7. Script resolves the latest Node.js LTS v22.x installer URL for the detected architecture (x64 or x86).
8. Script downloads the Node.js MSI (~30 MB) to `%TEMP%\node-lts-installer.msi` with progress shown.
9. Script runs `msiexec /i ... /qn /norestart` silently (no user clicks needed).
10. MSI exits with code 0 → success.
11. Script refreshes PATH from the registry (so `node` and `npm` are available in the current session without restarting).
12. Script verifies `node --version` and `npm --version` now work.
13. Script checks Git → not found → prints a friendly "not required" message.
14. Script verifies `backend/` and `frontend/` folders exist.
15. Script creates `backend/.env` from `backend/.env.example`.
16. Script runs `npm install` in `backend/` → downloads all backend dependencies.
17. Script runs `npm install` in `frontend/` → downloads all frontend dependencies.
18. Script checks ports 5000 and 5173 → both free.
19. Script prints success message with credentials, asks "Launch now? (y/n)".
20. User types `y` → backend starts on port 5000, frontend starts on port 5173, browser opens to `http://localhost:5173`.

**Result:** Fully working POS system with zero manual downloads.

---

### (b) Machine that already has Node.js installed

**What happens:**

1. User double-clicks `install.bat`.
2. UAC prompt appears → user clicks **Yes**.
3. Script checks for Node.js → **found** (e.g. `v22.14.0`).
4. Script checks for npm → **found**.
5. Script **skips** the Node.js download and install entirely.
6. Script checks Git → found or not, either way it's informational only.
7. Script verifies project folders exist.
8. Script creates `backend/.env` if missing (or keeps existing one).
9. Script runs `npm install` in `backend/` and `frontend/` (fast if node_modules already exist).
10. Script checks ports.
11. Script asks "Launch now? (y/n)".
12. User types `y` → servers start, browser opens.

**Result:** Fast setup — only npm install and launch steps take time.

---

### (c) Machine where the internet drops mid-install

**Scenario 1: Internet drops during Node.js download**

1. Script is downloading the Node.js MSI.
2. `Invoke-WebRequest` throws a timeout/connection error.
3. Script catches the exception, prints:
   ```
   [X] Failed to download or install Node.js: The operation has timed out
   ```
4. Script prints helpful suggestions (check internet, re-run).
5. Script waits for a key press, then exits with code 1.
6. **No partial install** — the MSI was never run, so nothing is half-installed.
7. `setup-log.txt` records the exact error and step.

**Scenario 2: Internet drops during `npm install`**

1. Script is running `npm install` in `backend/`.
2. npm fails with a network error (e.g. `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`).
3. Script captures the npm exit code (non-zero) and the full error output.
4. Script prints:
   ```
   [X] Backend npm install FAILED (exit code: 1)
   Error details:
   npm ERR! code ECONNRESET
   npm ERR! network request to https://registry.npmjs.org/... failed
   ```
5. Script prints possible causes (no internet, permissions, corrupted lock file).
6. Script waits for a key press, then exits with code 1.
7. **No half-installed state** — npm's own cache handles partial downloads; re-running the script will resume/retry.
8. `setup-log.txt` records the full npm error output.

**Scenario 3: Internet drops after Node.js installed but before npm install**

1. Node.js is installed successfully.
2. Script refreshes PATH, verifies `node` and `npm` work.
3. Script runs `npm install` → fails due to no internet.
4. Same handling as Scenario 2.
5. **Node.js remains installed** (that's fine — it's a complete, valid install).
6. User reconnects internet and re-runs `install.bat` → Node.js is detected, npm install retries.

**Result:** In all cases, the script fails loudly with clear messages, never silently, and never leaves a broken half-install. Re-running the script after fixing the issue resumes cleanly.

---

## Common Failure Cases & Messages

| Problem | What the script does |
|---------|---------------------|
| **No internet** | Prints `[X] No internet connection detected.` with instructions to connect and re-run. |
| **Permission denied** | Node.js MSI install fails → prints exit code and "Permission denied (make sure you're running as Administrator)" hint. |
| **Port 5000 in use** | Prints a warning: "Port 5000 is already in use (backend)." with options to close the app or change PORT in `.env`. |
| **Port 5173 in use** | Prints a warning. Vite auto-picks a different port, so this is non-fatal. |
| **Another installer running** | Waits up to 2 minutes for `msiexec` to finish. If still busy, prints a clear error and exits. |
| **npm install fails** | Prints the full npm error output in red, plus likely causes. Never fails silently. |
| **backend/ or frontend/ missing** | Prints the exact path that's missing and tells the user to check the folder structure. |
| **node/npm not in PATH after install** | Refreshes PATH from registry. If still missing, tells the user to open a new Command Prompt and re-run. |

---

## Troubleshooting

If something goes wrong:

1. **Check `setup-log.txt`** in the project root — it has timestamps and the exact error.
2. **Re-run `install.bat`** — the script is idempotent (safe to re-run). It will skip already-completed steps.
3. **If Node.js was installed but npm fails**, try deleting `node_modules` and `package-lock.json` in the failing folder, then re-run.
4. **If the browser doesn't open**, manually go to `http://localhost:5173`.
5. **If the backend won't start**, check that port 5000 is free, or change `PORT` in `backend/.env`.

---

## Manual Start (after setup)

If you chose "n" at the launch prompt, or want to start the app later:

```cmd
cd backend
node index.js
```

In a second terminal:

```cmd
cd frontend
npm run dev
```

Then open `http://localhost:5173` in your browser.