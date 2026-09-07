<#
  同じ社内ネットワークの別の端末(ノートPC・スマホなど)のブラウザから、この画面を開けるようにする。

    allow  … Windowsファイアウォールに受信規則を1本足す
    deny   … その規則を消して、元の「このPCからしか開けない」状態に戻す
    show   … いまどのURLで開けるかを表示する
    doctor … つながらないときの原因を、サーバー側から一通り調べる

  ■ 待ち受け側(Next.js)の設定は不要
    npm run dev / npm run start のどちらにも -H 0.0.0.0 が付いており、
    最初からすべてのネットワークアダプターで待っている。塞いでいるのは
    Windows のファイアウォールだけなので、ここを開ける。

  ■ -Scope で「どこから来た通信を通すか」を決める
    private … 社内で使うプライベートIP全体(10/8・172.16/12・192.168/16)。**既定**。
              社内が複数のサブネットに分かれていても届く。インターネット側の
              アドレスからは通さない。
    subnet  … このPCと同じサブネットだけ。いちばん狭いが、別サブネットの端末は弾かれる。
    any     … 制限なし。通常は不要。

    ※ 既定を private にしているのは、社内LANが1つのサブネットとは限らないため。
      このPCは 172.23.66.x にいるが、DNSは 10.11.21.x にあり、実際に複数の
      サブネットにまたがっている。subnet だと別サブネットの端末から開けない。
#>
[CmdletBinding()]
param(
  [ValidateSet('allow', 'deny', 'show', 'doctor')]
  [string] $Action = 'show',
  [int] $Port = 3000,
  [ValidateSet('private', 'subnet', 'any')]
  [string] $Scope = 'private'
)

$ErrorActionPreference = 'Stop'
$rule = "Tenbai Dashboard (TCP $Port)"

$scopeAddresses = switch ($Scope) {
  'private' { @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16') }
  'subnet'  { @('LocalSubnet') }
  'any'     { @('Any') }
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $me = New-Object Security.Principal.WindowsPrincipal($id)
  return $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-LanIps {
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne '127.0.0.1' } |
    Sort-Object IPAddress
}

function Get-LanUrls {
  Get-LanIps | ForEach-Object { "http://$($_.IPAddress):$Port" }
}

function Get-Rule {
  Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue
}

function Show-Urls {
  Write-Host ''
  Write-Host "  このPCから   : http://localhost:$Port"
  Write-Host '  他の端末から :'
  $urls = @(Get-LanUrls)
  if ($urls.Count -eq 0) {
    Write-Host '    (IPアドレスが取得できませんでした。ネットワークにつながっていますか?)'
  } else {
    $urls | ForEach-Object { Write-Host "    $_" }
  }
  Write-Host ''
}

function Show-NeedAdmin {
  Write-Host ''
  Write-Host '  この操作には管理者権限が必要です。' -ForegroundColor Yellow
  Write-Host '  .cmd ファイルを右クリック →「管理者として実行」してください。' -ForegroundColor Yellow
  Write-Host ''
}

function Write-Check($label, $ok, $detail) {
  if ($ok) { $mark = '  OK  '; $color = 'Green' } else { $mark = '  NG  '; $color = 'Yellow' }
  Write-Host $mark -ForegroundColor $color -NoNewline
  Write-Host " $label"
  if ($detail) { Write-Host "         $detail" -ForegroundColor DarkGray }
}

switch ($Action) {

  'allow' {
    if (-not (Test-Admin)) { Show-NeedAdmin; exit 1 }

    # 何度実行しても同じ結果になるよう、いったん消してから作り直す
    Get-Rule | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $rule -Description '転売リサーチダッシュボード。社内の別端末から使うための受信許可。' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Domain, Private -RemoteAddress $scopeAddresses | Out-Null

    Write-Host ''
    Write-Host "  許可しました: TCP $Port (送信元: $Scope)" -ForegroundColor Green
    Write-Host "               $($scopeAddresses -join ', ')" -ForegroundColor DarkGray
    Show-Urls
    Write-Host '  それでも開けないときは、原因を調べます:'
    Write-Host '    ops\lan-doctor.cmd'
    Write-Host ''
    Write-Host '  許可をやめるときは ops\deny-lan-access.cmd を管理者として実行してください。'
    Write-Host ''
  }

  'deny' {
    if (-not (Test-Admin)) { Show-NeedAdmin; exit 1 }

    if (-not (Get-Rule)) {
      Write-Host ''
      Write-Host '  規則はもともと入っていません。このPC以外からは開けない状態です。'
      Write-Host ''
      exit 0
    }
    Get-Rule | Remove-NetFirewallRule
    Write-Host ''
    Write-Host '  規則を削除しました。このPC以外からは開けなくなります。' -ForegroundColor Green
    Write-Host ''
  }

  'show' {
    Show-Urls
    $r = Get-Rule
    if ($r) {
      $addr = ($r | Get-NetFirewallAddressFilter).RemoteAddress
      Write-Host "  ファイアウォール: 許可済み(送信元: $($addr -join ', '))" -ForegroundColor Green
    } else {
      Write-Host '  ファイアウォール: 未設定 — 他の端末からは開けません。' -ForegroundColor Yellow
      Write-Host '  ops\allow-lan-access.cmd を「管理者として実行」してください(初回のみ)。'
    }
    Write-Host ''
  }

  'doctor' {
    Write-Host ''
    Write-Host "===== 他の端末から開けないときの診断 (TCP $Port) =====" -ForegroundColor Cyan
    Write-Host ''

    # ① 画面(Next.js)が動いていて、外向きの窓口で待っているか
    $listen = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    $anyBind = @($listen | Where-Object { $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' })
    if ($listen.Count -gt 0) {
      $where = ($listen | ForEach-Object { "$($_.LocalAddress):$Port" }) -join ', '
      Write-Check '画面が起動している' $true "待ち受け: $where"
      Write-Check '外向きの窓口で待っている' ($anyBind.Count -gt 0) $(
        if ($anyBind.Count -gt 0) { 'すべてのアダプターで待ち受け中' }
        else { 'localhost だけで待っています。-H 0.0.0.0 を付けて起動してください' })
    } else {
      Write-Check '画面が起動している' $false 'ops\start-app.cmd で起動してください'
    }

    # ② ファイアウォールの規則
    $r = Get-Rule
    if ($r) {
      Write-Check 'ファイアウォールの許可がある' $true "規則「$rule」"
      $addr = @(($r | Get-NetFirewallAddressFilter).RemoteAddress)
      $narrow = ($addr -contains 'LocalSubnet')
      Write-Check '許可する送信元が社内全体をカバーしている' (-not $narrow) $(
        if ($narrow) { '同じサブネットのみ。別サブネットの端末は弾かれます → -Scope private で入れ直してください' }
        else { "送信元: $($addr -join ', ')" })

      # 有効なネットワークプロファイルと、規則が適用されるプロファイルが噛み合っているか
      $active = "$((Get-NetConnectionProfile | Select-Object -First 1).NetworkCategory)"
      switch ($active) {
        'DomainAuthenticated' { $mapped = 'Domain' }
        'Private'             { $mapped = 'Private' }
        'Public'              { $mapped = 'Public' }
        default               { $mapped = $active }
      }
      $ruleProfile = "$($r.Profile)"
      $covered = ($ruleProfile -eq 'Any') -or ($ruleProfile -match $mapped)
      Write-Check '規則が今のネットワークに適用される' $covered "今のネットワーク: $mapped / 規則: $ruleProfile"
    } else {
      Write-Check 'ファイアウォールの許可がある' $false 'ops\allow-lan-access.cmd を管理者として実行してください'
    }

    # ③ このPCのアドレス
    Write-Host ''
    Write-Host '  このPCのIPアドレス:' -ForegroundColor Cyan
    Get-LanIps | ForEach-Object { Write-Host "    $($_.IPAddress)/$($_.PrefixLength)  ($($_.InterfaceAlias))" }

    # ④ 実際に外から届いているか(ファイアウォールのログ)
    Write-Host ''
    $log = "$env:systemroot\system32\LogFiles\Firewall\pfirewall.log"
    $prof = Get-NetFirewallProfile -Profile Domain
    if (-not $prof.LogBlocked) {
      Write-Host '  ファイアウォールのログが無効です。有効にすると、外から届いているかが分かります:' -ForegroundColor Yellow
      Write-Host '    Set-NetFirewallProfile -Profile Domain,Private -LogBlocked True'
    } elseif (Test-Path $log) {
      $rows = @()
      foreach ($line in (Get-Content $log -ErrorAction SilentlyContinue)) {
        if ($line -match '^#' -or $line.Trim() -eq '') { continue }
        $f = $line -split '\s+'
        if ($f.Length -gt 7 -and $f[7] -eq "$Port" -and $f[4] -ne $f[5]) { $rows += , $f }
      }
      $dropped = @($rows | Where-Object { $_[2] -eq 'DROP' })
      $allowed = @($rows | Where-Object { $_[2] -eq 'ALLOW' })
      Write-Host "  外部の端末から TCP $Port への通信: 許可 $($allowed.Count)件 / 遮断 $($dropped.Count)件" -ForegroundColor Cyan
      if ($dropped.Count -gt 0) {
        Write-Host '    遮断された送信元(直近):' -ForegroundColor Yellow
        $dropped | Select-Object -Last 5 | ForEach-Object { Write-Host "      $($_[0]) $($_[1])  from $($_[4])" }
        Write-Host '    → この送信元が許可範囲に入っていません。-Scope private で入れ直してください。' -ForegroundColor Yellow
      }
      if ($allowed.Count -eq 0 -and $dropped.Count -eq 0) {
        $firstIp = (Get-LanIps | Select-Object -First 1).IPAddress
        Write-Host '    外の端末からの通信は1件も記録されていません。' -ForegroundColor Yellow
        Write-Host '    → 通信がこのPCまで届いていません。相手の端末側を確認してください:' -ForegroundColor Yellow
        Write-Host '        ・URLを http:// から、検索窓ではなくアドレス欄に入れているか'
        Write-Host '        ・ブラウザやOSにプロキシ設定が入っていないか(社内プロキシは3000番を通さないことがあります)'
        Write-Host "        ・その端末から  ping $firstIp  が通るか"
      }
    } else {
      Write-Host '  ログファイルはまだ作られていません(記録対象の通信がありません)。'
    }

    # ⑤ 相手の端末で試してもらうこと
    Write-Host ''
    Write-Host '  相手の端末で試してもらうこと:' -ForegroundColor Cyan
    Get-LanUrls | ForEach-Object { Write-Host "    1) ブラウザのアドレス欄に  $_  を貼り付ける(検索窓ではなく)" }
    $ip = (Get-LanIps | Select-Object -First 1).IPAddress
    Write-Host '    2) 開けなければ、コマンドプロンプトで:'
    Write-Host "         ping $ip"
    Write-Host "         powershell Test-NetConnection $ip -Port $Port"
    Write-Host '       ping が通って Test-NetConnection が失敗 → このPC側の許可範囲の問題'
    Write-Host '       ping も通らない                        → ネットワーク(経路)の問題'
    Write-Host ''
  }
}
