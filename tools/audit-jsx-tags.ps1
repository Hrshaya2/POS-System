# Catches JSX tags (<Foo />) whose identifier is neither imported nor declared
# locally in the same file - e.g. lucide icons missing from the import list.
# These compile to global lookups that crash at render time.
$ErrorActionPreference = 'Stop'
$targets = @('d:\Nangi\POS\frontend\src\pages\StockManagementPage.jsx') +
  (Get-ChildItem 'd:\Nangi\POS\frontend\src\components\Stock\*.jsx' | ForEach-Object FullName)

$issues = @()
foreach ($f in $targets) {
  $txt = [IO.File]::ReadAllText($f)
  $known = @{}

  # Everything named in any import statement.
  foreach ($m in [regex]::Matches($txt, "import\s+(?:\w+\s*,\s*)?\{([^}]*)\}\s*from")) {
    foreach ($part in $m.Groups[1].Value.Split(',')) {
      # 'A as B' binds B locally - keep the post-alias name.
      $nm = if ($part -match '\bas\s+(\w+)\s*$') { $Matches[1] } else { ($part -replace '\s+as\s+.*$', '').Trim() }
      if ($nm) { $known[$nm] = $true }
    }
  }
  foreach ($m in [regex]::Matches($txt, '(?m)^\s*import\s+(\w+)\s+from\s')) {
    $known[$m.Groups[1].Value] = $true
  }
  # Mixed imports ('Default, { named }') - register the default binding.
  foreach ($m in [regex]::Matches($txt, '(?m)^\s*import\s+(\w+)\s*,\s*\{')) {
    $known[$m.Groups[1].Value] = $true
  }

  # Local declarations: functions, consts, destructured props, params, vars.
  foreach ($m in [regex]::Matches($txt, '(?m)^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)')) { $known[$m.Groups[1].Value] = $true }
  foreach ($m in [regex]::Matches($txt, '\bconst\s+(\w+)\s*=')) { $known[$m.Groups[1].Value] = $true }
  # Destructured component parameters (covers multi-line lists).
  foreach ($m in [regex]::Matches($txt, '\{([^{}]*)\}\s*=\s*(?:props)?')) {
    foreach ($part in $m.Groups[1].Value.Split(',')) {
      $nm = ($part -replace '[=:].*$', '').Trim()
      if ($nm -match '^\w+$') { $known[$nm] = $true }
    }
  }

  # Every capitalized JSX tag in this file.
  $used = @{}
  foreach ($m in [regex]::Matches($txt, '<([A-Z]\w+)')) { $used[$m.Groups[1].Value] = $true }

  foreach ($tag in @($used.Keys)) {
    if (-not $known.ContainsKey($tag)) {
      $idx = $txt.IndexOf('<' + $tag)
      $line = (($txt.Substring(0, $idx)) -split "`n").Count
      $issues += ("{0} -> JSX tag '<{1}>' is never imported/declared, near line {2}" -f ([IO.Path]::GetFileName($f)), $tag, $line)
    }
  }
}

if ($issues.Count -eq 0) {
  Write-Output 'ICON AUDIT CLEAN: every JSX tag resolves to an import or local declaration.'
} else {
  Write-Output ('ICON AUDIT FOUND ' + $issues.Count + ' ISSUE(S):')
  $issues | Sort-Object -Unique
}
