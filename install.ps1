# ============================================================
#  Nangi POS - Automated Setup Script
#  Handles: Node.js install, npm install, .env creation,
#           server launch, logging, and error handling.
# ============================================================

# --- Configuration ---
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogFile = Join-Path $ScriptDir 'setup-log.txt'
$NodeInstallerUrl = $null  # Resolved dynamically below
$NodeInstallerPath = Join-Path $env:TEMP 'node-lts-installer.msi'
$BackendDir = Join-Path $ScriptDir 'backend'
$FrontendDir = Join-Path $ScriptDir 'frontend'
$BackendEnv = Join-Path $BackendDir '.env'
$BackendEnvExample = Join-Path $BackendDir '.env.example'

# Detect architecture (x64 or x86)
$Is64Bit = [System.Environment]::Is64BitOperatingSystem
$ArchSuffix = if ($Is64Bit) { 'x64' } else { 'x86' }

# --- Logging helpers ---
function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$timestamp] [$Level] $Message"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Write-Success {
    param([string]$Message)
    Write-Host "`n  [OK] $Message" -ForegroundColor Green
    Write-Log "SUCCESS: $Message"
}

function Write-WarningMsg {
    param([string]$Message)
    Write-Host "`n  [!] $Message" -ForegroundColor Yellow
    Write-Log "WARNING: $Message"
}

function Write-ErrorMsg {
    param([string]$Message)
    Write-Host "`n  [X] $Message" -ForegroundColor Red
    Write-Log "ERROR: $Message"
}

function Write-Step {
    param([string]$Message)
    Write-Host "`n============================================" -ForegroundColor Cyan
    Write-Host "  $Message" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Log "STEP: $Message"
}

# --- Initialize log ---
if (Test-Path $LogFile) {
    Remove-Item $LogFile -Force
}
Write-Log "Nangi POS Setup started"
Write-Log "Script directory: $ScriptDir"
Write-Log "PowerShell version: $($PSVersionTable.PSVersion.ToString())"
Write-Log "OS: $([System.Environment]::OSVersion.VersionString)"
Write-Log "Architecture detected: $ArchSuffix"

# --- Check internet connectivity ---
function Test-InternetConnection {
    Write-Step "Checking internet connection..."
    try {
        $result = Test-Connection -ComputerName 'nodejs.org' -Count 1 -Quiet -ErrorAction Stop
        if ($result) {
            Write-Success "Internet connection detected"
            return $true
        }
    } catch {
        # Fall back to DNS/HTTP check
        try {
            $response = Invoke-WebRequest -Uri 'https://nodejs.org' -Method Head -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                Write-Success "Internet connection detected"
                return $true
            }
        } catch {
            # No internet
        }
    }
    Write-ErrorMsg "No internet connection detected."
    Write-Host "`n  This setup requires internet access to download Node.js and npm packages." -ForegroundColor Yellow
    Write-Host "  Please connect to the internet and run this script again." -ForegroundColor Yellow
    Write-Host "`n  If you already have Node.js installed, you can skip the download by" -ForegroundColor Yellow
    Write-Host "  ensuring 'node' and 'npm' are available in your PATH, then re-run." -ForegroundColor Yellow
    return $false
}

# --- Refresh PATH from registry (so newly installed Node.js is found) ---
function Update-PathFromRegistry {
    Write-Log "Refreshing PATH from system registry..."
    $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machinePath;$userPath"
    Write-Log "PATH refreshed. New PATH length: $($env:Path.Length) chars"
}

# --- Check if Node.js is installed ---
function Get-NodeVersion {
    try {
        $nodeVersion = & node --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $nodeVersion) {
            return $nodeVersion.Trim()
        }
    } catch {}
    return $null
}

function Get-NpmVersion {
    try {
        $npmVersion = & npm --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $npmVersion) {
            return $npmVersion.Trim()
        }
    } catch {}
    return $null
}

# --- Check if another installer is running ---
function Test-InstallerRunning {
    $processes = Get-Process -Name 'msiexec' -ErrorAction SilentlyContinue
    if ($processes) {
        Write-WarningMsg "Windows Installer (msiexec) is currently running."
        Write-Host "  Another installation may be in progress. Waiting for it to finish..." -ForegroundColor Yellow
        Write-Log "Waiting for msiexec to finish..."
        $timeout = 120  # 2 minutes max wait
        $elapsed = 0
        while ($processes -and $elapsed -lt $timeout) {
            Start-Sleep -Seconds 5
            $elapsed += 5
            $processes = Get-Process -Name 'msiexec' -ErrorAction SilentlyContinue
        }
        if ($processes) {
            Write-ErrorMsg "Another installation is still in progress after waiting 2 minutes."
            Write-Host "  Please close any other installers and run this script again." -ForegroundColor Yellow
            return $false
        }
        Write-Success "Previous installer finished"
    }
    return $true
}

# --- Resolve latest Node.js LTS installer URL ---
function Resolve-NodeInstallerUrl {
    Write-Log "Resolving latest Node.js LTS installer URL..."
    try {
        # Fetch the official Node.js releases index and find the latest LTS
        $releaseIndex = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
        if ($releaseIndex) {
            # Find the first entry that has an 'lts' property (not $false)
            $latestLts = $releaseIndex | Where-Object { $_.lts -and $_.lts -ne $false } | Select-Object -First 1
            if ($latestLts) {
                $version = $latestLts.version.TrimStart('v')
                # Build direct download URL for the .msi
                $script:NodeInstallerUrl = "https://nodejs.org/dist/v$version/node-v$version-$ArchSuffix.msi"
                Write-Log "Resolved latest Node.js LTS v$version ($ArchSuffix): $script:NodeInstallerUrl"
                return $true
            }
        }
    } catch {
        Write-Log "Failed to resolve LTS from index.json: $($_.Exception.Message)"
    }

    # Fallback: try known LTS version patterns (try latest first, then older)
    Write-Log "Falling back to known Node.js LTS URLs..."
    $fallbackVersions = @('latest-v24.x', 'latest-v22.x', 'latest-v20.x')
    foreach ($line in $fallbackVersions) {
        $candidateUrl = "https://nodejs.org/dist/$line/node-latest-$ArchSuffix.msi"
        Write-Log "Trying fallback: $candidateUrl"
        try {
            # Resolve the actual version from the latest-*.x directory listing
            $dirPage = Invoke-WebRequest -Uri "https://nodejs.org/dist/$line/" -UseBasicParsing -TimeoutSec 20
            $dirPattern = "node-v(\d+\.\d+\.\d+)-$ArchSuffix\.msi"
            $dirMatch = [regex]::Match($dirPage.Content, $dirPattern)
            if ($dirMatch.Success) {
                $fallbackVersion = $dirMatch.Groups[1].Value
                $script:NodeInstallerUrl = "https://nodejs.org/dist/$line/node-v$fallbackVersion-$ArchSuffix.msi"
                Write-Log "Using fallback URL: $script:NodeInstallerUrl"
                return $true
            }
        } catch {
            Write-Log "  Fallback $line failed: $($_.Exception.Message)"
        }
    }

    # Last resort: hardcoded known-good URL
    $script:NodeInstallerUrl = "https://nodejs.org/dist/latest-v22.x/node-v22.14.0-$ArchSuffix.msi"
    Write-Log "Using last-resort URL: $script:NodeInstallerUrl"
    return $true
}

# --- Download and install Node.js LTS ---
function Install-NodeJS {
    Write-Step "Node.js not found - downloading and installing LTS version..."

    # Check internet first
    if (-not (Test-InternetConnection)) {
        return $false
    }

    # Check for other installers
    if (-not (Test-InstallerRunning)) {
        return $false
    }

    # Resolve the latest installer URL
    if (-not (Resolve-NodeInstallerUrl)) {
        Write-ErrorMsg "Could not determine the Node.js download URL."
        return $false
    }

    Write-Host "  Downloading Node.js LTS installer from nodejs.org..." -ForegroundColor Cyan
    Write-Log "Downloading from: $NodeInstallerUrl"

    try {
        # Download with progress
        $ProgressPreference = 'Continue'
        Invoke-WebRequest -Uri $NodeInstallerUrl -OutFile $NodeInstallerPath -UseBasicParsing -TimeoutSec 300
        $ProgressPreference = 'SilentlyContinue'

        if (-not (Test-Path $NodeInstallerPath)) {
            Write-ErrorMsg "Download failed - installer file not found."
            return $false
        }

        $fileSize = (Get-Item $NodeInstallerPath).Length
        Write-Log "Downloaded installer: $NodeInstallerPath ($([math]::Round($fileSize / 1MB, 1)) MB)"
        Write-Success "Download complete"

        Write-Host "`n  Installing Node.js silently (this may take a few minutes)..." -ForegroundColor Cyan
        Write-Log "Running silent install..."

        # Run MSI silently
        $installProcess = Start-Process -FilePath 'msiexec.exe' `
            -ArgumentList "/i `"$NodeInstallerPath`" /qn /norestart" `
            -Wait -PassThru -NoNewWindow

        if ($installProcess.ExitCode -eq 0 -or $installProcess.ExitCode -eq 3010) {
            Write-Success "Node.js installed successfully"
            Write-Log "MSI exit code: $($installProcess.ExitCode)"
            return $true
        } else {
            Write-ErrorMsg "Node.js installation failed with exit code: $($installProcess.ExitCode)"
            Write-Host "  Common causes:" -ForegroundColor Yellow
            Write-Host "    - Permission denied (make sure you're running as Administrator)" -ForegroundColor Yellow
            Write-Host "    - Another installation is in progress" -ForegroundColor Yellow
            Write-Host "    - Corrupted installer download" -ForegroundColor Yellow
            return $false
        }
    } catch {
        Write-ErrorMsg "Failed to download or install Node.js: $($_.Exception.Message)"
        return $false
    }
}

# --- Main flow ---
Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "   Nangi POS - Automated Setup" -ForegroundColor Cyan
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Check Node.js
Write-Step "Checking Node.js installation..."
$nodeVersion = Get-NodeVersion

if ($nodeVersion) {
    Write-Success "Node.js found: v$nodeVersion"
    $npmVersion = Get-NpmVersion
    if ($npmVersion) {
        Write-Success "npm found: v$npmVersion"
    } else {
        Write-WarningMsg "npm not found in PATH. Refreshing PATH..."
        Update-PathFromRegistry
        $npmVersion = Get-NpmVersion
        if (-not $npmVersion) {
            Write-ErrorMsg "npm is not available even after PATH refresh."
            Write-Host "  Please reinstall Node.js manually or check your PATH settings." -ForegroundColor Yellow
            Write-Host "  Setup cannot continue without npm." -ForegroundColor Yellow
            Write-Host "`n  Press any key to exit..."
            $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
            exit 1
        }
        Write-Success "npm found after PATH refresh: v$npmVersion"
    }
} else {
    Write-Host "  Node.js not found. Will install automatically." -ForegroundColor Yellow
    $installed = Install-NodeJS
    if (-not $installed) {
        Write-Host "`n  Setup cannot continue without Node.js." -ForegroundColor Red
        Write-Host "  Please check the log file: $LogFile" -ForegroundColor Yellow
        Write-Host "`n  Press any key to exit..."
        $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
        exit 1
    }

    # Refresh PATH to pick up newly installed Node.js
    Update-PathFromRegistry

    # Verify node and npm are now available
    $nodeVersion = Get-NodeVersion
    $npmVersion = Get-NpmVersion

    if (-not $nodeVersion -or -not $npmVersion) {
        Write-ErrorMsg "Node.js was installed but 'node' or 'npm' is not available in PATH."
        Write-Host "  This can happen if the PATH was not updated correctly." -ForegroundColor Yellow
        Write-Host "  Please close this window, open a NEW Command Prompt, and run install.bat again." -ForegroundColor Yellow
        Write-Host "`n  Press any key to exit..."
        $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
        exit 1
    }

    Write-Success "Node.js v$nodeVersion installed and available"
    Write-Success "npm v$npmVersion installed and available"
}

# Step 2: Check Git (only informational - project files are already on disk)
Write-Step "Checking Git (optional)..."
$gitVersion = $null
try {
    $gitVersion = & git --version 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Success "Git found: $($gitVersion.Trim())"
    }
} catch {}
if (-not $gitVersion) {
    Write-WarningMsg "Git not found. This is OK - the project files are already on this machine."
    Write-Log "Git not required for this setup (project files present locally)"
}

# Step 3: Verify backend and frontend directories exist
Write-Step "Verifying project structure..."
if (-not (Test-Path $BackendDir)) {
    Write-ErrorMsg "Backend directory not found: $BackendDir"
    Write-Host "  Make sure the 'backend' folder is in the same directory as this script." -ForegroundColor Yellow
    Write-Host "`n  Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
}
if (-not (Test-Path $FrontendDir)) {
    Write-ErrorMsg "Frontend directory not found: $FrontendDir"
    Write-Host "  Make sure the 'frontend' folder is in the same directory as this script." -ForegroundColor Yellow
    Write-Host "`n  Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
}
Write-Success "Project structure verified (backend/ and frontend/ found)"

# Step 4: Create .env from .env.example if needed
Write-Step "Checking backend environment configuration..."
if (-not (Test-Path $BackendEnv)) {
    if (Test-Path $BackendEnvExample) {
        Copy-Item $BackendEnvExample $BackendEnv
        Write-Success "Created backend/.env from backend/.env.example"
        Write-Log "Copied .env.example to .env"
    } else {
        Write-WarningMsg "Neither .env nor .env.example found in backend/."
        Write-Host "  Creating a default .env file..." -ForegroundColor Yellow
        $defaultEnv = @"
# Nangi POS - Backend Environment Configuration
PORT=5000
JWT_SECRET=change_this_to_a_long_random_secret_string
MONGO_URI=
SALE_DISCOUNT_APPROVAL_LIMIT_PERCENT=10
"@
        Set-Content -Path $BackendEnv -Value $defaultEnv -Encoding UTF8
        Write-Success "Created default backend/.env"
        Write-Log "Created default .env (no .env.example was present)"
    }
} else {
    Write-Success "backend/.env already exists - keeping existing configuration"
}

# Step 5: npm install in backend
Write-Step "Installing backend dependencies (npm install)..."
Write-Host "  This may take a few minutes on first run..." -ForegroundColor Cyan
Write-Log "Running npm install in: $BackendDir"

Push-Location $BackendDir
try {
    $npmOutput = & npm install 2>&1
    $npmExitCode = $LASTEXITCODE

    if ($npmExitCode -eq 0) {
        Write-Success "Backend dependencies installed successfully"
        Write-Log "Backend npm install completed (exit code 0)"
    } else {
        Write-ErrorMsg "Backend npm install FAILED (exit code: $npmExitCode)"
        Write-Host "`n  Error details:" -ForegroundColor Red
        Write-Host "  ----------------------------------------" -ForegroundColor Red
        $npmOutput | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        Write-Host "  ----------------------------------------" -ForegroundColor Red
        Write-Log "Backend npm install error output:"
        $npmOutput | ForEach-Object { Write-Log "  $_" -Level 'ERROR' }
        Write-Host "`n  Possible causes:" -ForegroundColor Yellow
        Write-Host "    - No internet connection (npm needs to download packages)" -ForegroundColor Yellow
        Write-Host "    - Permission issues on the backend folder" -ForegroundColor Yellow
        Write-Host "    - Corrupted package-lock.json" -ForegroundColor Yellow
        Write-Host "`n  Press any key to exit..."
        $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
        exit 1
    }
} catch {
    Write-ErrorMsg "Backend npm install threw an exception: $($_.Exception.Message)"
    Write-Host "`n  Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
} finally {
    Pop-Location
}

# Step 6: npm install in frontend
Write-Step "Installing frontend dependencies (npm install)..."
Write-Host "  This may take a few minutes on first run..." -ForegroundColor Cyan
Write-Log "Running npm install in: $FrontendDir"

Push-Location $FrontendDir
try {
    $npmOutput = & npm install 2>&1
    $npmExitCode = $LASTEXITCODE

    if ($npmExitCode -eq 0) {
        Write-Success "Frontend dependencies installed successfully"
        Write-Log "Frontend npm install completed (exit code 0)"
    } else {
        Write-ErrorMsg "Frontend npm install FAILED (exit code: $npmExitCode)"
        Write-Host "`n  Error details:" -ForegroundColor Red
        Write-Host "  ----------------------------------------" -ForegroundColor Red
        $npmOutput | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        Write-Host "  ----------------------------------------" -ForegroundColor Red
        Write-Log "Frontend npm install error output:"
        $npmOutput | ForEach-Object { Write-Log "  $_" -Level 'ERROR' }
        Write-Host "`n  Possible causes:" -ForegroundColor Yellow
        Write-Host "    - No internet connection (npm needs to download packages)" -ForegroundColor Yellow
        Write-Host "    - Permission issues on the frontend folder" -ForegroundColor Yellow
        Write-Host "    - Corrupted package-lock.json" -ForegroundColor Yellow
        Write-Host "`n  Press any key to exit..."
        $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
        exit 1
    }
} catch {
    Write-ErrorMsg "Frontend npm install threw an exception: $($_.Exception.Message)"
    Write-Host "`n  Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
} finally {
    Pop-Location
}

# Step 7: Check if ports are already in use
Write-Step "Checking if ports 5000 and 5173 are available..."
$port5000InUse = $false
$port5173InUse = $false

# Try modern Get-NetTCPConnection first, fall back to netstat on older systems
$tcpChecked = $false
try {
    $conn5000 = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue
    if ($conn5000) {
        $port5000InUse = $true
    }
    $conn5173 = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
    if ($conn5173) {
        $port5173InUse = $true
    }
    $tcpChecked = $true
} catch {
    # netstat fallback
}

if (-not $tcpChecked) {
    Write-Log "Get-NetTCPConnection unavailable - using netstat fallback"
    try {
        $netstatOutput = & netstat -ano 2>&1
        foreach ($line in $netstatOutput) {
            if ($line -match 'TCP\s+\S+:5000\s+\S+\s+LISTENING') {
                $port5000InUse = $true
            }
            if ($line -match 'TCP\s+\S+:5173\s+\S+\s+LISTENING') {
                $port5173InUse = $true
            }
        }
    } catch {
        Write-WarningMsg "Could not check port availability (Get-NetTCPConnection and netstat both failed)."
    }
}

if ($port5000InUse) {
    Write-WarningMsg "Port 5000 is already in use (backend)."
    Write-Host "  Another application may be running on this port." -ForegroundColor Yellow
    Write-Host "  The backend may fail to start. You can:" -ForegroundColor Yellow
    Write-Host "    - Close the other application and try again" -ForegroundColor Yellow
    Write-Host "    - Change the PORT in backend/.env" -ForegroundColor Yellow
} else {
    Write-Success "Port 5000 is available (backend)"
}

if ($port5173InUse) {
    Write-WarningMsg "Port 5173 is already in use (frontend)."
    Write-Host "  Another application may be running on this port." -ForegroundColor Yellow
    Write-Host "  Vite will automatically pick a different port if 5173 is busy." -ForegroundColor Yellow
} else {
    Write-Success "Port 5173 is available (frontend)"
}

# Step 8: Success message and launch prompt
Write-Step "Setup Complete!"
Write-Host ""
Write-Host "  ============================================" -ForegroundColor Green
Write-Host "   Nangi POS is ready to use!" -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  What was done:" -ForegroundColor Cyan
Write-Host "    - Node.js: $nodeVersion" -ForegroundColor White
Write-Host "    - npm: $npmVersion" -ForegroundColor White
Write-Host "    - Backend dependencies: installed" -ForegroundColor White
Write-Host "    - Frontend dependencies: installed" -ForegroundColor White
Write-Host "    - Environment config: ready" -ForegroundColor White
Write-Host ""
Write-Host "  Default login credentials:" -ForegroundColor Cyan
Write-Host "    Admin:     admin@nangi.com / admin123" -ForegroundColor White
Write-Host "    Shop Owner: shop@nangi.com / shop123" -ForegroundColor White
Write-Host "    Cashier:   cashier@nangi.com / cashier123" -ForegroundColor White
Write-Host ""
Write-Log "Setup completed successfully"

# Ask to launch
Write-Host "  Would you like to launch the app now? (y/n): " -ForegroundColor Cyan -NoNewline
$launchChoice = Read-Host

if ($launchChoice -match '^[Yy]') {
    Write-Step "Launching Nangi POS..."

    # Start backend server
    Write-Host "  Starting backend server on http://localhost:5000 ..." -ForegroundColor Cyan
    Push-Location $BackendDir
    $backendProcess = Start-Process -FilePath 'node' -ArgumentList 'index.js' -WorkingDirectory $BackendDir -WindowStyle Hidden -PassThru
    Pop-Location
    Write-Log "Backend started with PID: $($backendProcess.Id)"

    # Wait a moment for backend to start
    Start-Sleep -Seconds 3

    # Start frontend server (npm is npm.cmd on Windows - must run via cmd.exe)
    Write-Host "  Starting frontend server on http://localhost:5173 ..." -ForegroundColor Cyan
    Push-Location $FrontendDir
    $npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npmCmd) {
        $npmCmd = (Get-Command npm -ErrorAction SilentlyContinue).Source
    }
    if (-not $npmCmd) {
        Write-ErrorMsg "Could not find npm command to start the frontend."
        Write-Host "  Please start the frontend manually with: cd frontend && npm run dev" -ForegroundColor Yellow
    } else {
        # .cmd files need to be launched via cmd.exe to execute properly
        $frontendProcess = Start-Process -FilePath 'cmd.exe' `
            -ArgumentList '/c', "cd /d `"$FrontendDir`" && `"$npmCmd`" run dev" `
            -WorkingDirectory $FrontendDir -WindowStyle Hidden -PassThru
        Write-Log "Frontend started with PID: $($frontendProcess.Id)"
    }
    Pop-Location

    # Wait for frontend to be ready
    Write-Host "  Waiting for servers to start..." -ForegroundColor Cyan
    Start-Sleep -Seconds 5

    # Open browser
    Write-Host "  Opening browser to http://localhost:5173 ..." -ForegroundColor Cyan
    try {
        Start-Process 'http://localhost:5173'
        Write-Success "Browser opened"
    } catch {
        Write-WarningMsg "Could not open browser automatically. Please open http://localhost:5173 manually."
    }

    Write-Host ""
    Write-Host "  Nangi POS is now running!" -ForegroundColor Green
    Write-Host "  Backend:  http://localhost:5000" -ForegroundColor White
    Write-Host "  Frontend: http://localhost:5173" -ForegroundColor White
    Write-Host ""
    Write-Host "  To stop the servers, close this window or use Task Manager." -ForegroundColor Yellow
    Write-Host "  To restart later, run install.bat again and choose 'n' when asked to launch," -ForegroundColor Yellow
    Write-Host "  then start the servers manually with:" -ForegroundColor Yellow
    Write-Host "    cd backend && node index.js" -ForegroundColor White
    Write-Host "    cd frontend && npm run dev" -ForegroundColor White
    Write-Host ""
    Write-Host "  Press any key to exit this setup window (servers keep running)..." -ForegroundColor Cyan
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
} else {
    Write-Host ""
    Write-Host "  Setup complete. You can start the app later with:" -ForegroundColor Cyan
    Write-Host "    cd backend && node index.js" -ForegroundColor White
    Write-Host "    cd frontend && npm run dev" -ForegroundColor White
    Write-Host "  Then open http://localhost:5173 in your browser." -ForegroundColor White
    Write-Host ""
    Write-Host "  Press any key to exit..." -ForegroundColor Cyan
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}

Write-Log "Setup script finished"