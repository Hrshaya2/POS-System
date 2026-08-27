# Catches the "toggleSelect is not defined" crash class: JSX attributes whose
# value is a bare identifier that is never defined in scope (imports,
# declarations, or props-destructures). oxlint/build miss these because they
# compile into global lookups that throw only at render time.
$ErrorActionPreference = 'Stop'
$src = 'd:\Nangi\POS\frontend\src'
$files = @("$src\pages\StockManagementPage.jsx") +
  (Get-ChildItem "$src\components\Stock\*.jsx" | ForEach-Object { $_.FullName })

$results = @()
foreach ($f in $files) {
  $txt = [IO.File]::ReadAllText($f)
  $defined = @{}

  # import bindings (named incl. multiline braces + defaults)
  foreach ($m in [regex]::Matches($txt, "import\s+(?:\w+\s*,\s*)?\{([^}]*)\}\s*from")) {
    foreach ($part in $m.Groups[1].Value.Split(',')) {
      $nm = ($part -replace '\s+as\s+.*$', '').Trim(); if ($nm) { $defined[$nm] = $true }
    }
  }
  foreach ($m in [regex]::Matches($txt, '(?m)^\s*import\s+(\w+)\s+from\s')) { $defined[$m.Groups[1].Value] = $true }

  # every declaration keyword binding
  foreach ($m in [regex]::Matches($txt, '(?:const|let|var|function)\s+(\w+)')) { $defined[$m.Groups[1].Value] = $true }
  # function component parameter lists, INCLUDING destructured props
  # ({ items, onClose }) and defaults (h = 56) - cross-line safe.
  foreach ($m in [regex]::Matches($txt, '(?s)function\s+\w+\s*\(([^)]*)\)')) {
    foreach ($nm in [regex]::Matches($m.Groups[1].Value, '([A-Za-z_$][\w$]*)')) {
      $defined[$nm.Groups[1].Value] = $true
    }
  }
  # object destructuring lists: const { a, b, c } = ...   (multiline safe)
  foreach ($m in [regex]::Matches($txt, '(?:const|let|var)\s*\{([^}]*)\}\s*='))
  {
    foreach ($part in $m.Groups[1].Value.Split(',')) {
      $nm = (($part -replace '\s*:\s*.*$', '') -replace '\s*=\s*.*$', '').Trim()
      if ($nm -match '^[\w$]+$') { $defined[$nm] = $true }
    }
  }
  # array destructuring (useState pairs etc.)
  foreach ($m in [regex]::Matches($txt, '(?:const|let|var)\s*\[([^\]]*)\]\s*=')) {
    foreach ($part in $m.Groups[1].Value.Split(',')) {
      $nm = $part.Trim().Split('=')[0].Trim(); if ($nm -match '^[\w$]+$') { $defined[$nm] = $true }
    }
  }
  # arrow-function params (common local helper signatures)
  foreach ($m in [regex]::Matches($txt, '\(\s*(\w+)\s*\)\s*=>|\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>')) {
    foreach ($g in @($m.Groups[1], $m.Groups[2], $m.Groups[3])) { if ($g.Value) { $defined[$g.Value] = $true } }
  }

  # JSX attributes whose value is a single bare identifier
  foreach ($m in [regex]::Matches($txt, '<[A-Za-z][\w.]*[^<>]*?\s([A-Za-z_$][\w$]*)=\{\s*([A-Za-z_$][\w$]*)\s*\}')) {
    $val = $m.Groups[2].Value
    if (-not $defined.ContainsKey($val)) {
      $line = (($txt.Substring(0, $m.Index)) -split "`n").Count
      $results += ("{0}:{1}: <{2}> gets {3}={{{4}}} - '{4}' IS NOT DEFINED IN SCOPE" -f `
        [IO.Path]::GetFileName($f), $line, $m.Groups[1].Value, $m.Groups[1].Value, $val)
    }
  }
}

if ($results.Count -eq 0) { Write-Output 'JSX-ID AUDIT CLEAN: every bare-identifier prop resolves.' }
else { Write-Output ('JSX-ID AUDIT FOUND ' + $results.Count + ' ISSUE(S):'); $results | Sort-Object -Unique }
