# sawhorse hook tests. Run: pwsh -NoProfile -File tests/hook.tests.ps1  (or powershell.exe)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$blockPush = Join-Path $repoRoot 'hooks/scripts/block-push.ps1'
$journal = Join-Path $repoRoot 'hooks/scripts/journal-append.ps1'
$exe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell.exe' }
if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
  Write-Host 'FAIL: no PowerShell executable found (pwsh or powershell.exe)'
  exit 1
}
if (-not (Test-Path $blockPush)) { Write-Host "FAIL: block-push script missing: $blockPush"; exit 1 }
if (-not (Test-Path $journal)) { Write-Host "FAIL: journal script missing: $journal"; exit 1 }

$cases = @(
  @{ cmd = 'git push'; expect = 'ask' },
  @{ cmd = 'GIT PUSH'; expect = 'ask' },
  @{ cmd = 'git -C repo push origin main'; expect = 'ask' },
  @{ cmd = 'git.exe push'; expect = 'ask' },
  @{ cmd = 'git.cmd push'; expect = 'ask' },
  @{ cmd = 'C:\tools\bin\git.exe push origin'; expect = 'ask' },
  @{ cmd = 'git add -A && git push'; expect = 'ask' },
  @{ cmd = 'git push --force-with-lease'; expect = 'ask' },
  @{ cmd = 'git push --no-verify'; expect = 'ask' },
  @{ cmd = 'cd /w;git push'; expect = 'ask' },
  @{ cmd = 'git -C work svn dcommit'; expect = 'ask' },
  @{ cmd = 'git svn dcommit'; expect = 'ask' },
  @{ cmd = 'git send-pack host refs/heads/main'; expect = 'ask' },
  @{ cmd = 'svn ci -m x'; expect = 'ask' },
  @{ cmd = 'svn -q commit -m x'; expect = 'ask' },
  @{ cmd = 'svn import . file:///repo'; expect = 'ask' },
  @{ cmd = 'hg push'; expect = 'ask' },
  @{ cmd = 'hg.exe push'; expect = 'ask' },
  @{ cmd = 'hg -R /repo push'; expect = 'ask' },
  @{ cmd = 'git commit -m msg'; expect = 'allow' },
  @{ cmd = 'git pushy --tags'; expect = 'allow' },
  @{ cmd = 'git log push-fix'; expect = 'allow' },
  @{ cmd = 'npm test'; expect = 'allow' },
  @{ cmd = ''; expect = 'allow' }
)

$fail = 0
foreach ($c in $cases) {
  $json = @{ tool_input = @{ command = $c.cmd } } | ConvertTo-Json -Compress
  $out = $json | & $exe -NoProfile -ExecutionPolicy Bypass -File $blockPush
  if ($LASTEXITCODE -ne 0) {
    $fail++
    Write-Host ("FAIL: '{0}' => child exited {1}" -f $c.cmd, $LASTEXITCODE)
    continue
  }
  $joined = ($out -join "`n").Trim()
  $decision = 'allow'
  if ($joined) { $decision = ($joined | ConvertFrom-Json).hookSpecificOutput.permissionDecision }
  if ($decision -ne $c.expect) {
    $fail++
    Write-Host ("FAIL: '{0}' => {1} (want {2})" -f $c.cmd, $decision, $c.expect)
  } else {
    Write-Host ("ok  : '{0}' => {1}" -f $c.cmd, $decision)
  }
}

# journal-append: BOM-less UTF-8 JSONL, appends preserved across invocations
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('siwb-test-' + [guid]::NewGuid().ToString('N'))
$oldProfile = $env:USERPROFILE
try {
  $env:USERPROFILE = $tmp
  foreach ($sid in @('t1', 't2')) {
    $in = @{ session_id = $sid; cwd = 'C:\work'; transcript_path = "$sid.jsonl"; reason = 'exit' } | ConvertTo-Json -Compress
    $in | & $exe -NoProfile -ExecutionPolicy Bypass -File $journal
    if ($LASTEXITCODE -ne 0) { $fail++; Write-Host "FAIL: journal hook exited $LASTEXITCODE" }
  }
  $jdir = Join-Path $tmp '.claude\sawhorse\journal'
  $jfiles = @(Get-ChildItem -Path $jdir -Filter '*.jsonl' -File -ErrorAction SilentlyContinue)
  if ($jfiles.Count -ne 1) {
    $fail++
    Write-Host "FAIL: expected exactly one journal file, found $($jfiles.Count)"
  } else {
    $jpath = $jfiles[0].FullName
    $bytes = [System.IO.File]::ReadAllBytes($jpath)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
      $fail++
      Write-Host 'FAIL: journal starts with BOM'
    } else {
      Write-Host 'ok  : journal has no BOM'
    }
    $lines = [System.IO.File]::ReadAllLines($jpath)
    if ($lines.Count -ne 2) {
      $fail++
      Write-Host "FAIL: expected 2 appended journal lines, found $($lines.Count)"
    } else {
      try {
        $ids = @($lines | ForEach-Object { ($_ | ConvertFrom-Json).session_id })
        if ($ids -contains 't1' -and $ids -contains 't2') {
          Write-Host 'ok  : journal appends preserved (2 parseable lines)'
        } else {
          $fail++
          Write-Host "FAIL: journal session ids wrong: $($ids -join ',')"
        }
      } catch {
        $fail++
        Write-Host "FAIL: journal line not parseable: $($_.Exception.Message)"
      }
    }
  }
} finally {
  $env:USERPROFILE = $oldProfile
  if (Test-Path $tmp) {
    try { Remove-Item -Recurse -Force $tmp } catch {
      $fail++
      Write-Host "FAIL: temp cleanup failed: $($_.Exception.Message)"
    }
  }
}

if ($fail -gt 0) { Write-Host "$fail test(s) failed"; exit 1 }
Write-Host "all $($cases.Count) block-push cases + journal checks passed"
