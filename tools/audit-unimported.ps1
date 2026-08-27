# Detects shared exports referenced by target files without being imported
# or locally declared there. Build/lint miss these because bare identifiers
# silently become global lookups that throw only at runtime.
$ErrorActionPreference = 'Stop'
$src = 'd:\Nangi\POS\frontend\src'

$targets = @(
  "$src\pages\StockManagementPage.jsx",
  "$src\services\stockService.js",
  "$src\utils\csv.js",
  "$src\db\database.js"
) + (Get-ChildItem "$src\components\Stock\*.jsx" | ForEach-Object { $_.FullName })

$sources = @(
  $targets,
  "$src\services\syncService.js",
  "$src\utils\barcode.js",
  "$src\components\Stock\constants.js"
) | ForEach-Object { $_ }

# 1) Collect every exported symbol across source files.
$exports = @{}
foreach ($f in $sources) {
  if (-not (Test-Path $f)) { continue }
  $t = [IO.File]::ReadAllText($f)
  foreach ($m in [regex]::Matches($t, '(?m)^export\s+(?:async\s+)?(?:const|function|class)\s+(\w+)')) {
    $exports[$m.Groups[1].Value] = $true
  }
}

# 2) Per target: build the set of names known to be importable/local, then
#    flag exported names used but not known.
$results = @()
foreach ($t in $targets) {
  $txt = [IO.File]::ReadAllText($t)
  $known = @{}

  # Named imports (including multiline braces) + default imports.
  foreach ($m in [regex]::Matches($txt, "import\s+(?:\w+\s*,\s*)?\{([^}]*)\}\s*from")) {
    foreach ($part in $m.Groups[1].Value.Split(',')) {
      $nm = ($part -replace '\s+as\s+.*$', '').Trim()
      if ($nm) { $known[$nm] = $true }
    }
  }
  foreach ($m in [regex]::Matches($txt, '(?m)^\s*import\s+(\w+)\s+from\s')) {
    $known[$m.Groups[1].Value] = $true
  }

  # Top-level declarations (function/const/let/var/class).
  foreach ($m in [regex]::Matches($txt, '(?m)^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+(\w+)')) {
    $known[$m.Groups[1].Value] = $true
  }

  foreach ($name in @($exports.Keys)) {
    if ($known.ContainsKey($name)) { continue }
    $usages = [regex]::Matches($txt, "(?<![.\w`"''])" + $name + "(?![\w`"''])")
    if ($usages.Count -gt 0) {
      $line = (($txt.Substring(0, $usages[0].Index)) -split "`n").Count
      $results += ("{0} -> uses '{1}' (from db/services/utils) without importing it, near line {2}" -f ([IO.Path]::GetFileName($t)), $name, $line)
    }
  }
}

if ($results.Count -eq 0) {
  Write-Output 'AUDIT CLEAN: no unimported shared exports detected.'
} else {
  Write-Output ('AUDIT FOUND ' + $results.Count + ' ISSUE(S):')
  $results | Sort-Object -Unique
}
