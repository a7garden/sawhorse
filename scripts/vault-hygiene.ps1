<#
.SYNOPSIS
  si-workbench 볼트 위생 점검. morning/lunch/evening 이 모드별로 호출한다.
.DESCRIPTION
  quick : 즉시형. 표준 폴더 밖 첨부 회수, attachmentFolderPath 교정, .base 템플릿 제외 보정,
          인덱스 자산 존재 확인. 되돌릴 수 있는 기계적 조치만 수행한다. (morning)
  scan  : 진단 전용. 죽은 링크, 고아 첨부, frontmatter 스키마 이탈을 찾아 보고만 한다.
          어떤 파일도 쓰지 않는다. (lunch)
  fix   : quick + scan. 기계적 조치를 하고, 판단이 필요한 항목은 목록으로 넘긴다. (evening)
  스킬이 노트를 하나씩 열어 읽는 대신 이 스크립트 한 번으로 목록만 받는 것이 목적이다.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$VaultPath,
  [ValidateSet('quick','scan','fix')][string]$Mode = 'quick'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

if (-not (Test-Path -LiteralPath $VaultPath)) { Write-Output "[오류] vault 경로 없음: $VaultPath"; exit 1 }
$V = (Resolve-Path -LiteralPath $VaultPath).Path.TrimEnd('\')

$StdFolders  = @('일지','사업','개념','첨부','템플릿')
$ImageExt    = @('.png','.jpg','.jpeg','.gif','.webp','.svg','.bmp')
$AttachExt   = $ImageExt + @('.pdf','.xlsx','.xls','.docx','.doc','.hwp','.hwpx','.pptx','.zip','.csv')
$IndexAssets = @('대시보드.md', '개념\개념.base', '사업\사업.base', '사업\개선.base', '일지\일지.base')

function Get-Rel([string]$full) { return $full.Substring($V.Length + 1) }
function Test-Excluded([string]$full) { return $full -match '\\\.(obsidian|git|trash)\\' }

function Write-Utf8([string]$full, [string]$text) {
  [System.IO.File]::WriteAllText($full, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# 파일명과 같은 H1 은 Obsidian 인라인 제목과 중복이다 (wiki 규범 제7조).
# 파일명과 "다른" H1 은 파일명이 담지 못한 정보이므로 절대 건드리지 않는다.
function Invoke-TitleDedup([bool]$doFix) {
  $hit = New-Object System.Collections.ArrayList
  $reFm   = [regex]'\A---\r?\n.*?\r?\n---\r?\n'
  $reH1   = [regex]'(?m)^\# (.+?)[ \t]*$'
  $reTail = [regex]'\A\r?\n(\r?\n)?'
  foreach ($f in $script:mdFiles) {
    $rel = Get-Rel $f.FullName
    if ($rel -like '템플릿\*') { continue }
    $txt = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8
    if ([string]::IsNullOrEmpty($txt)) { continue }
    $prefix = 0; $rest = $txt
    $fm = [regex]::Match($txt, $reFm.ToString(), 'Singleline')
    if ($fm.Success) { $prefix = $fm.Length; $rest = $txt.Substring($prefix) }
    $h1 = $reH1.Match($rest)
    if (-not $h1.Success) { continue }
    if ($h1.Groups[1].Value.Trim() -ne $f.BaseName) { continue }
    [void]$hit.Add($rel)
    if (-not $doFix) { continue }
    $end = $h1.Index + $h1.Length
    $tail = $reTail.Match($rest.Substring($end))
    if ($tail.Success) { $end += $tail.Length }
    Write-Utf8 $f.FullName ($txt.Substring(0, $prefix) + $rest.Substring(0, $h1.Index) + $rest.Substring($end))
  }
  return $hit
}

$mdFiles = @(Get-ChildItem -LiteralPath $V -Recurse -File -Filter *.md |
             Where-Object { -not (Test-Excluded $_.FullName) })
$allFiles = @(Get-ChildItem -LiteralPath $V -Recurse -File |
              Where-Object { -not (Test-Excluded $_.FullName) -and -not $_.Name.StartsWith('.') })

$moved = 0
$fixed = 0
$warn = New-Object System.Collections.ArrayList

# ======================= quick / fix =======================
if ($Mode -eq 'quick' -or $Mode -eq 'fix') {
  Write-Output "== 볼트 위생: 즉시 점검 =="

  # 1) 표준 폴더 밖 첨부 회수
  $strays = @($allFiles | Where-Object {
      $AttachExt -contains $_.Extension.ToLower()
    } | Where-Object {
      $rel = Get-Rel $_.FullName
      $top = $rel.Split('\')[0]
      ($rel -eq $_.Name) -or ($StdFolders -notcontains $top)
    })
  foreach ($f in $strays) {
    if ($ImageExt -contains $f.Extension.ToLower()) {
      $destDir = Join-Path $V '첨부\스크린샷'
    } else {
      $destDir = Join-Path $V '첨부'
    }
    if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    $dest = Join-Path $destDir $f.Name
    if (Test-Path -LiteralPath $dest) {
      [void]$warn.Add("[충돌] $(Get-Rel $f.FullName) — 대상에 같은 이름 존재, 이동하지 않음")
    } else {
      Move-Item -LiteralPath $f.FullName -Destination $dest
      Write-Output "[이동] $(Get-Rel $f.FullName) -> $(Get-Rel $dest)"
      $moved++
    }
  }
  if ($strays.Count -eq 0) { Write-Output "[이동] 표준 폴더 밖 첨부 없음" }

  # 2) attachmentFolderPath (붙여넣기 이미지가 루트에 쌓이는 근본 원인)
  $appJson = Join-Path $V '.obsidian\app.json'
  if (Test-Path -LiteralPath $appJson) {
    $cfg = Get-Content -LiteralPath $appJson -Raw -Encoding UTF8 | ConvertFrom-Json
    $cur = $null
    if ($cfg.PSObject.Properties.Name -contains 'attachmentFolderPath') { $cur = $cfg.attachmentFolderPath }
    if ([string]::IsNullOrWhiteSpace($cur) -or $cur -eq '/' -or $cur -eq '.') {
      $cfg | Add-Member -NotePropertyName attachmentFolderPath -NotePropertyValue '첨부/스크린샷' -Force
      ($cfg | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $appJson -Encoding UTF8
      Write-Output "[설정] attachmentFolderPath = 첨부/스크린샷 (새로 지정)"
      $fixed++
    } else {
      Write-Output "[설정] attachmentFolderPath = $cur (사용자 설정 유지)"
    }
  } else {
    New-Item -ItemType Directory -Path (Split-Path $appJson) -Force | Out-Null
    '{"attachmentFolderPath":"첨부/스크린샷"}' | Set-Content -LiteralPath $appJson -Encoding UTF8
    Write-Output "[설정] app.json 생성, attachmentFolderPath = 첨부/스크린샷"
    $fixed++
  }

  # 3) 루트에 남은 미분류 노트 (판단이 필요하므로 옮기지 않고 보고만)
  $rootNotes = @($mdFiles | Where-Object { (Get-Rel $_.FullName) -eq $_.Name -and $_.Name -ne '대시보드.md' })
  if ($rootNotes.Count -gt 0) {
    Write-Output "[미분류] 루트 노트 $($rootNotes.Count)건 — 어디로 보낼지 판단 필요"
    foreach ($n in $rootNotes) { Write-Output "  - $($n.Name)" }
  } else {
    Write-Output "[미분류] 루트 노트 없음"
  }

  # 4) 인덱스 자산 존재 확인 (없으면 안내만 — 여기서 만들지 않는다)
  $missingAssets = @($IndexAssets | Where-Object { -not (Test-Path -LiteralPath (Join-Path $V $_)) })
  if ($missingAssets.Count -gt 0) {
    Write-Output "[자산] 없음: $($missingAssets -join ', ') — /si-workbench:init-vault 필요"
  } else {
    Write-Output "[자산] 대시보드·base 4종 모두 있음"
  }

  # 5) .base 가 템플릿 폴더를 제외하는지 (템플릿 노트도 진짜 type 값을 갖고 있다)
  $bases = @(Get-ChildItem -LiteralPath $V -Recurse -File -Filter *.base |
             Where-Object { -not (Test-Excluded $_.FullName) })
  foreach ($b in $bases) {
    $txt = Get-Content -LiteralPath $b.FullName -Raw -Encoding UTF8
    # 이미 폴더로 범위를 좁힌 base(개선의 사업 범위)는 템플릿이 섞일 수 없으므로 건드리지 않는다.
    $scoped = $txt -match 'file\.inFolder\("[^"]+"\)'
    if ($txt -match '(?m)^\s*-\s*type\s*==' -and -not $scoped) {
      $ins = "`$1    - not:`r`n        - file.inFolder(""템플릿"")`r`n"
      $patched = [regex]::Replace($txt, '(?m)^(filters:\r?\n  and:\r?\n)', $ins)
      if ($patched -ne $txt) {
        Write-Utf8 $b.FullName $patched
        Write-Output "[base] $(Get-Rel $b.FullName) — 템플릿 폴더 제외 추가"
        $fixed++
      } else {
        [void]$warn.Add("[base] $(Get-Rel $b.FullName) — 템플릿 제외 누락, 구조가 달라 자동 보정 실패")
      }
    }
  }

  # 5-b) 개선 폴더의 범위별 base 존재 확인 + 파생 표 잔존 탐지 (보고만 — 고치는 것은 improve 스킬)
  $impRoot = Join-Path $V '사업'
  if (Test-Path -LiteralPath $impRoot) {
    $impDirs = @(Get-ChildItem -LiteralPath $impRoot -Recurse -Directory -Filter '개선' -ErrorAction SilentlyContinue |
                 Where-Object { -not (Test-Excluded $_.FullName) })
    foreach ($d in $impDirs) {
      $hasNote = @(Get-ChildItem -LiteralPath $d.FullName -Recurse -File -Filter *.md |
                   Where-Object { (Get-Content -LiteralPath $_.FullName -TotalCount 12 -Encoding UTF8) -match '^type:\s*개선\s*$' })
      if ($hasNote.Count -eq 0) { continue }
      if (@(Get-ChildItem -LiteralPath $d.FullName -File -Filter *.base).Count -eq 0) {
        Write-Output "[개선base] $(Get-Rel $d.FullName) — 사업 범위 base 없음 (/si-workbench:improve 가 만든다)"
      }
      # 개선 폴더는 평면이다 — 화면은 노트의 url 프로퍼티가 나눈다. 옛 화면단위 하위 폴더는 보고만 한다.
      foreach ($sd in @(Get-ChildItem -LiteralPath $d.FullName -Directory)) {
        $n = @(Get-ChildItem -LiteralPath $sd.FullName -File -Filter *.md).Count
        if ($n -gt 0) {
          Write-Output "[개선폴더] $(Get-Rel $sd.FullName) — 화면단위 하위 폴더 (옛 구조). 문제 노트를 개선/ 바로 아래로 올릴 것 — 화면 구분은 url 프로퍼티가 한다"
        }
      }
      # 노트 프로퍼티를 베껴 둔 표(행이 [[링크]] 로 시작)는 반드시 어긋난다.
      foreach ($m in @(Get-ChildItem -LiteralPath $d.FullName -Recurse -File -Filter *.md)) {
        $rows = @([regex]::Matches((Get-Content -LiteralPath $m.FullName -Raw -Encoding UTF8), '(?m)^\|\s*\[\[')).Count
        if ($rows -ge 3) {
          Write-Output "[파생표] $(Get-Rel $m.FullName) — 문제 노트를 베낀 표 $rows 행. .base 뷰 임베드로 바꿀 것"
        }
      }
    }
  }

  # 6) 파일명과 같은 H1 제거 (Obsidian 은 파일명을 인라인 제목으로 이미 보여준다 — 규범 제7조)
  $dupTitles = Invoke-TitleDedup $true
  if ($dupTitles.Count -gt 0) {
    Write-Output "[제목중복] 파일명과 같은 H1 $($dupTitles.Count)건 제거"
    foreach ($d in $dupTitles) { Write-Output "  - $d" }
    $fixed += $dupTitles.Count
  } else {
    Write-Output "[제목중복] 없음"
  }
}

# ======================= scan / fix =======================
if ($Mode -eq 'scan' -or $Mode -eq 'fix') {
  Write-Output ""
  Write-Output "== 볼트 위생: 진단 =="

  # 링크 해석 사전: 노트 basename + 첨부 파일명 + aliases
  $names = @{}
  foreach ($f in $mdFiles)  { $names[$f.BaseName] = $true }
  foreach ($f in $allFiles) { $names[$f.Name] = $true }

  $linkRefs = @{}
  $bodies = @{}
  foreach ($f in $mdFiles) {
    $txt = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8
    if ($null -eq $txt) { $txt = '' }
    $bodies[$f.FullName] = $txt
    foreach ($m in [regex]::Matches($txt, '(?m)^aliases:\s*\[(.+?)\]')) {
      foreach ($a in ($m.Groups[1].Value -split ',')) {
        $a = $a.Trim().Trim('"').Trim("'")
        if ($a) { $names[$a] = $true }
      }
    }
  }
  # 링크 수집 전에 "링크가 아닌 것"을 걷어낸다:
  #   HTML 주석 — 템플릿에서 복사돼 온 안내 주석의 설명용 예시([[링크]] 등)
  #   코드펜스·인라인 코드 — 위키링크 문법 자체를 설명하는 문장의 `[[링크]]`
  # 걷어내지 않으면 노트마다 가짜 죽은 링크가 생겨 진짜 죽은 링크가 묻힌다.
  $reComment = [regex]'(?s)<!--.*?-->'
  $reFence   = [regex]'(?s)```.*?```'
  $reCode    = [regex]'`[^`\r\n]*`'
  foreach ($f in $mdFiles) {
    $visible = $reComment.Replace($bodies[$f.FullName], '')
    $visible = $reFence.Replace($visible, '')
    $visible = $reCode.Replace($visible, '')
    foreach ($m in [regex]::Matches($visible, '\[\[([^\]\|#]+)')) {
      $t = $m.Groups[1].Value.TrimEnd('\').Trim()
      if (-not $t) { continue }
      if (-not $linkRefs.ContainsKey($t)) { $linkRefs[$t] = New-Object System.Collections.ArrayList }
      [void]$linkRefs[$t].Add((Get-Rel $f.FullName))
    }
  }

  # 템플릿 안의 예시 링크(다른개념 등)는 죽은 링크가 아니다
  $dead = @()
  foreach ($t in $linkRefs.Keys) {
    if ($names.ContainsKey($t)) { continue }
    $src = @($linkRefs[$t] | Where-Object { $_ -notlike '템플릿\*' } | Select-Object -Unique)
    if ($src.Count -gt 0) { $dead += [pscustomobject]@{ Target = $t; Sources = $src } }
  }
  if ($dead.Count -eq 0) {
    Write-Output "[죽은링크] 없음"
  } else {
    Write-Output "[죽은링크] $($dead.Count)건"
    foreach ($d in ($dead | Sort-Object Target)) {
      Write-Output "  - [[$($d.Target)]] <- $($d.Sources -join ', ')"
    }
  }

  # 개념 수집 섹션 — '## 개념 수집' 아래에서 아직 승격되지 않은 줄
  # 사용자는 아무 노트에나 이 섹션을 만들고 용어를 문맥과 함께 적어둔다.
  # 이미 [[링크]]가 붙은 줄은 승격된 것으로 보고 건너뛴다(재실행 멱등).
  # `## 개념 수집` 섹션에서 아직 승격되지 않은 줄을 뽑는다.
  # 목록(- * + / 1.)이 하나라도 있는 섹션에서는 목록이 아닌 줄을 "공통 문맥"으로 보고 용어로 세지 않는다.
  # (예: "산사태 정보 시스템에서 검토 대상을 찾을 때 쓰는 용어임" 같은 머리글이 매번 승격 대기로 뜨는 것을 막는다.)
  # 목록이 전혀 없는 섹션은 한 줄에 용어 하나로 적은 것이므로 모든 줄을 후보로 본다.
  $harvest = New-Object System.Collections.ArrayList
  $reList = [regex]'^\s*([-*+]|\d+\.)\s+'
  foreach ($f in $mdFiles) {
    $rel = Get-Rel $f.FullName
    if ($rel -like '템플릿\*') { continue }
    $lines = $bodies[$f.FullName] -split "\r?\n"
    $sections = New-Object System.Collections.ArrayList   # 섹션마다 후보 줄을 모았다가 끝에서 판정
    $cur = $null
    $inSec = $false
    $secLevel = 0
    $inComment = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      $ln = $lines[$i]
      # 여러 줄 HTML 주석 건너뛰기 (안내 주석이 용어로 잡히면 안 된다)
      if ($inComment) {
        if ($ln.Contains('-->')) { $inComment = $false }
        continue
      }
      if ($ln -match '<!--' -and -not $ln.Contains('-->')) { $inComment = $true; continue }
      if ($ln -match '^\s*<!--') { continue }

      $h = [regex]::Match($ln, '^(#{2,6})\s*(.+?)\s*$')
      if ($h.Success) {
        $lvl = $h.Groups[1].Value.Length
        # 정확히 '개념 수집' 인 헤딩만 (대시보드의 '개념 수집함' 등은 제외)
        if ($h.Groups[2].Value -match '^개념\s*수집$') {
          $cur = [pscustomobject]@{ HasList = $false; Items = (New-Object System.Collections.ArrayList) }
          [void]$sections.Add($cur)
          $inSec = $true; $secLevel = $lvl; continue
        }
        if ($inSec -and $lvl -le $secLevel) { $inSec = $false; $cur = $null }
        continue
      }
      if (-not $inSec) { continue }
      if ([string]::IsNullOrWhiteSpace($ln)) { continue }
      $isList = $reList.IsMatch($ln)
      if ($isList) { $cur.HasList = $true }
      if ($ln.Contains('[[')) { continue }   # 이미 승격된 줄
      [void]$cur.Items.Add([pscustomobject]@{ Line = ($i + 1); Text = $ln.Trim(); IsList = $isList })
    }
    foreach ($s in $sections) {
      foreach ($it in $s.Items) {
        if ($s.HasList -and -not $it.IsList) { continue }   # 목록 있는 섹션의 산문 줄 = 문맥
        [void]$harvest.Add("$rel : $($it.Line) : $($it.Text)")
      }
    }
  }
  if ($harvest.Count -eq 0) {
    Write-Output "[수집] 승격 대기 없음"
  } else {
    Write-Output "[수집] 승격 대기 $($harvest.Count)줄 — 문맥째로 읽어 개념 노트로 올릴 것"
    foreach ($h in $harvest) { Write-Output "  - $h" }
  }

  # 고아 첨부 (참조 없음) — 삭제하지 않는다
  $mdText = ($bodies.Values) -join "`n"
  $attachments = @($allFiles | Where-Object { $AttachExt -contains $_.Extension.ToLower() })
  $orphans = @($attachments | Where-Object { -not $mdText.Contains($_.Name) })
  if ($orphans.Count -eq 0) {
    Write-Output "[고아첨부] 없음"
  } else {
    Write-Output "[고아첨부] $($orphans.Count)건 (삭제하지 않음)"
    foreach ($o in $orphans) { Write-Output "  - $(Get-Rel $o.FullName)" }
  }

  # frontmatter 스키마 대조
  $tplKeys = @{}
  $tplDir = Join-Path $V '템플릿'
  if (Test-Path -LiteralPath $tplDir) {
    foreach ($t in (Get-ChildItem -LiteralPath $tplDir -File -Filter *.md)) {
      $raw = Get-Content -LiteralPath $t.FullName -Raw -Encoding UTF8
      $m = [regex]::Match($raw, '(?s)\A---\r?\n(.*?)\r?\n---')
      if ($m.Success) {
        $tplKeys[$t.BaseName] = @([regex]::Matches($m.Groups[1].Value, '(?m)^([A-Za-z_][A-Za-z0-9_]*):') |
                                  ForEach-Object { $_.Groups[1].Value })
      }
    }
  }
  $typeAlias = @{ '연구' = '사업' }
  $issues = New-Object System.Collections.ArrayList
  foreach ($f in $mdFiles) {
    $rel = Get-Rel $f.FullName
    if ($rel -like '템플릿\*') { continue }
    # improve 스킬이 의도적으로 frontmatter 없이 두는 산출물
    if ($f.Name -like '문제목록 - *.md' -or $f.Name -like '* 문제목록.md') { continue }
    if ($f.Name -eq '개선.md' -and $rel -like '*\개선\개선.md') { continue }
    $raw = $bodies[$f.FullName]
    $m = [regex]::Match($raw, '(?s)\A---\r?\n(.*?)\r?\n---')
    if (-not $m.Success) { [void]$issues.Add("$rel : frontmatter 없음"); continue }
    $fm = $m.Groups[1].Value
    $tm = [regex]::Match($fm, '(?m)^type:\s*(\S+)')
    if (-not $tm.Success) { [void]$issues.Add("$rel : type 없음"); continue }
    $type = $tm.Groups[1].Value
    if ($type -eq '대시보드') { continue }
    if ($typeAlias.ContainsKey($type)) { $type = $typeAlias[$type] }
    if (-not $tplKeys.ContainsKey($type)) { [void]$issues.Add("$rel : type '$type' 에 맞는 템플릿 없음"); continue }
    $have = @([regex]::Matches($fm, '(?m)^([A-Za-z_][A-Za-z0-9_]*):') | ForEach-Object { $_.Groups[1].Value })
    $miss = @($tplKeys[$type] | Where-Object { $have -notcontains $_ })
    if ($miss.Count -gt 0) { [void]$issues.Add("$rel : 키 누락 $($miss -join ', ')") }
  }
  if ($issues.Count -eq 0) {
    Write-Output "[스키마] 이상 없음 ($($mdFiles.Count)개 노트)"
  } else {
    Write-Output "[스키마] $($issues.Count)건"
    foreach ($s in $issues) { Write-Output "  - $s" }
  }

  # 파일명과 같은 H1 (scan 은 진단만 — 제거는 quick/fix 가 한다)
  if ($Mode -eq 'scan') {
    $dupTitles = Invoke-TitleDedup $false
    if ($dupTitles.Count -gt 0) {
      Write-Output "[제목중복] 파일명과 같은 H1 $($dupTitles.Count)건 — 다음 quick/fix 실행이 제거한다"
      foreach ($d in $dupTitles) { Write-Output "  - $d" }
    } else {
      Write-Output "[제목중복] 없음"
    }
  }
}

foreach ($w in $warn) { Write-Output $w }
Write-Output ""
Write-Output "[요약] mode=$Mode · 이동 $moved · 교정 $fixed · 경고 $($warn.Count)"
