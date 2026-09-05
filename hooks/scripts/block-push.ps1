# sawhorse PreToolUse hook: force confirmation for remote-mutating VCS commands (company policy).
$ErrorActionPreference = 'SilentlyContinue'
$raw = [Console]::In.ReadToEnd()
if (-not $raw) { exit 0 }
$e = $raw | ConvertFrom-Json
$cmd = ''
if ($e.tool_input -and $e.tool_input.command) { $cmd = [string]$e.tool_input.command }
if ($cmd -eq '') { exit 0 }
# token class [^ ;&|>]+ excludes ; & | > so each && / ; segment is anchored separately.
if ($cmd -match '(^|[&|(>;\s\\/])git(\.exe|\.cmd)?(\s+[^ ;&|>]+)*\s+(push|send-pack)(?![A-Za-z0-9_-])') { $needConfirm = $true }
if ($cmd -match '(^|[&|(>;\s\\/])svn(\.exe|\.cmd)?(\s+[^ ;&|>]+)*\s+(commit|ci|import)(?![A-Za-z0-9_-])') { $needConfirm = $true }
if ($cmd -match '(^|[&|(>;\s\\/])git(\.exe|\.cmd)?(\s+[^ ;&|>]+)*\s+svn\s+dcommit(?![A-Za-z0-9_-])') { $needConfirm = $true }
if ($cmd -match '(^|[&|(>;\s\\/])hg(\.exe|\.cmd)?(\s+[^ ;&|>]+)*\s+push(?![A-Za-z0-9_-])') { $needConfirm = $true }
if ($needConfirm) {
  @{
    hookSpecificOutput = @{
      hookEventName          = 'PreToolUse'
      permissionDecision     = 'ask'
      permissionDecisionReason = 'sawhorse 회사 정책 확인: 원격 저장소 변경(git push / svn commit)입니다. 회사 규정상 허용되는 경우에만 실행을 승인하세요.'
    }
  } | ConvertTo-Json -Depth 5
}
exit 0
