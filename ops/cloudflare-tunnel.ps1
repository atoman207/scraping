<#
  Cloudflare Tunnel で、この画面を「どこからでも」開けるようにする。

    status          … いまの状態を表示する
    quick           … その場かぎりの公開URLを発行する(Cloudflareのアカウント不要)
    setup           … 独自ドメインで固定URLにする(要: Cloudflareアカウント + ドメイン)
    service-install … 固定URLの構成を Windows サービスにして、再起動後も自動で復帰させる
    service-remove  … そのサービスを削除する

  ■ なぜトンネルなのか
    このVPSはNATの内側にいて、自分自身のIPは 172.23.66.149 という**プライベートアドレス**。
    インターネットからは届かない。ポート開放をするには契約先(GMO)のコンソールで
    ポートフォワードの設定が要るが、トンネルなら **こちらから外へ出ていく通信だけ** で
    経路ができるので、ポート開放も固定グローバルIPも要らない。HTTPSも自動で付く。

  ■ quick と setup の違い
    quick … https://<ランダムな語>.trycloudflare.com が毎回**変わる**。アカウント不要。
            URLは推測されにくいので、ポートを開けっ放しにするより見つかりにくい。
            ただし cloudflared を止めるとURLは消える。試用・一時的な共有向け。
    setup … https://<好きな名前>.<自分のドメイン> に固定できる。Windowsサービスとして
            常駐させられるので、VPSを再起動しても復帰する。継続運用はこちら。

  ■ setup にする前に必ず読むこと
    固定URLはドメイン名から辿れる(証明書の透明性ログにも載る)ため、
    **誰でもログイン画面にたどり着ける**状態になる。いまの管理者アカウントは
    lib/auth.ts で admin / Admin に固定されており、ログイン画面を開くたびに
    その値へ戻される仕様なので、固定URLで公開する前に必ずどちらかを行うこと:
      ・Cloudflare Access を有効にして、ログイン画面の手前で認証させる
      ・.env.local の BASIC_AUTH_USER / BASIC_AUTH_PASS を設定する
#>
[CmdletBinding()]
param(
  [ValidateSet('status', 'quick', 'setup', 'service-install', 'service-remove', 'domain')]
  [string] $Action = 'status',
  [int] $Port = 3000,
  [string] $TunnelName = 'tenbai',
  [string] $Hostname = ''
)

$ErrorActionPreference = 'Stop'
$exe = 'C:\Program Files\cloudflared\cloudflared.exe'
$cfDir = Join-Path $env:USERPROFILE '.cloudflared'
$cert = Join-Path $cfDir 'cert.pem'
$config = Join-Path $cfDir 'config.yml'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $me = New-Object Security.Principal.WindowsPrincipal($id)
  return $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Check($label, $ok, $detail) {
  if ($ok) { $mark = '  OK  '; $color = 'Green' } else { $mark = '  --  '; $color = 'Yellow' }
  Write-Host $mark -ForegroundColor $color -NoNewline
  Write-Host " $label"
  if ($detail) { Write-Host "         $detail" -ForegroundColor DarkGray }
}

function Assert-Cloudflared {
  if (-not (Test-Path $exe)) {
    Write-Host ''
    Write-Host '  cloudflared が入っていません。次で入ります:' -ForegroundColor Yellow
    Write-Host '    curl.exe -L -o "C:\Program Files\cloudflared\cloudflared.exe" `'
    Write-Host '      https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    Write-Host ''
    exit 1
  }
}

function Test-AppRunning {
  $l = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return [bool]$l
}

switch ($Action) {

  'status' {
    Write-Host ''
    Write-Host '===== Cloudflare Tunnel の状態 =====' -ForegroundColor Cyan
    Write-Host ''
    Write-Check 'cloudflared が入っている' (Test-Path $exe) $(if (Test-Path $exe) { (& $exe --version) })
    Write-Check "画面が起動している (localhost:$Port)" (Test-AppRunning) $(
      if (Test-AppRunning) { '待ち受け中' } else { 'ops\start-app.cmd で起動してください（トンネルの転送先です）' })
    Write-Check 'Cloudflareにログイン済み' (Test-Path $cert) $(
      if (Test-Path $cert) { $cert } else { '固定URLを使うときだけ必要。quick は不要' })
    Write-Check '固定URLの設定ファイルがある' (Test-Path $config) $config

    $svc = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
    Write-Check 'Windowsサービスとして常駐している' ([bool]$svc) $(
      if ($svc) { "状態: $($svc.Status) / 起動種別: $($svc.StartType)" }
      else { '再起動後も自動で復帰させるなら service-install' })

    Write-Host ''
    Write-Host '  いますぐ公開したいだけなら : ops\tunnel-quick.cmd' -ForegroundColor Cyan
    Write-Host '  固定URLで継続運用するなら  : ops\tunnel-setup.cmd' -ForegroundColor Cyan
    Write-Host ''
  }

  'quick' {
    Assert-Cloudflared
    if (-not (Test-AppRunning)) {
      Write-Host ''
      Write-Host "  画面(localhost:$Port)が動いていません。先に ops\start-app.cmd を実行してください。" -ForegroundColor Yellow
      Write-Host '  トンネルはここへ転送するだけなので、止まっているとURLを開いてもエラーになります。' -ForegroundColor Yellow
      Write-Host ''
      exit 1
    }
    Write-Host ''
    Write-Host '  一時的な公開URLを発行します。' -ForegroundColor Cyan
    Write-Host '  下に出てくる https://....trycloudflare.com が、どこからでも開けるURLです。'
    Write-Host '  このウィンドウを閉じるとURLは無効になります(次回は別のURLになります)。'
    Write-Host ''
    & $exe tunnel --url "http://localhost:$Port" --no-autoupdate
  }

  'setup' {
    Assert-Cloudflared
    if (-not $Hostname) {
      Write-Host ''
      Write-Host '  公開したいホスト名を -Hostname で指定してください。' -ForegroundColor Yellow
      Write-Host '    例: powershell -File ops\cloudflare-tunnel.ps1 -Action setup -Hostname tenbai.example.com'
      Write-Host ''
      Write-Host '  ドメインは、あらかじめ Cloudflare にネームサーバーを向けてある必要があります。' -ForegroundColor Yellow
      Write-Host '  独自ドメインが無い場合は、ops\tunnel-quick.cmd（毎回URLが変わる方式）を使ってください。'
      Write-Host ''
      exit 1
    }

    # ① ブラウザでCloudflareにログインし、証明書を取得する(初回のみ)
    if (-not (Test-Path $cert)) {
      Write-Host ''
      Write-Host '  [1/4] Cloudflareにログインします。ブラウザが開くので、対象ドメインを選んで許可してください。' -ForegroundColor Cyan
      Write-Host ''
      & $exe tunnel login
      if (-not (Test-Path $cert)) {
        Write-Host ''
        Write-Host '  ログインが完了していません。ブラウザでの許可を最後まで進めてから、もう一度実行してください。' -ForegroundColor Yellow
        Write-Host ''
        exit 1
      }
    } else {
      Write-Host ''
      Write-Host '  [1/4] ログイン済みです。' -ForegroundColor Green
    }

    # ② トンネルを作る(すでにあれば作らない)
    Write-Host "  [2/4] トンネル「$TunnelName」を用意します。" -ForegroundColor Cyan
    $existing = & $exe tunnel list 2>&1 | Select-String -SimpleMatch $TunnelName
    if (-not $existing) { & $exe tunnel create $TunnelName } else { Write-Host '        すでにあります。' }

    # ③ 設定ファイルを書く。トンネルの資格情報(json)は作成時に .cloudflared へ置かれる
    Write-Host '  [3/4] 設定ファイルを書きます。' -ForegroundColor Cyan
    $credFile = Get-ChildItem -Path $cfDir -Filter '*.json' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $credFile) {
      Write-Host '        トンネルの資格情報ファイルが見つかりませんでした。' -ForegroundColor Yellow
      exit 1
    }
    $yml = @(
      "tunnel: $TunnelName",
      "credentials-file: $($credFile.FullName)",
      '',
      'ingress:',
      "  - hostname: $Hostname",
      "    service: http://localhost:$Port",
      '  - service: http_status:404'
    ) -join "`r`n"
    Set-Content -Path $config -Value $yml -Encoding utf8
    Write-Host "        $config"

    # ④ DNSレコードを向ける
    Write-Host "  [4/4] $Hostname をこのトンネルに向けます。" -ForegroundColor Cyan
    & $exe tunnel route dns $TunnelName $Hostname

    Write-Host ''
    Write-Host "  完了しました: https://$Hostname" -ForegroundColor Green
    Write-Host ''
    Write-Host '  次にやること:' -ForegroundColor Cyan
    Write-Host '    1. 再起動後も動くように常駐させる … ops\tunnel-service.cmd(管理者として実行)'
    Write-Host '    2. **公開前に入口を塞ぐ**。固定URLは誰でもたどり着けます:'
    Write-Host '       ・Cloudflare Zero Trust > Access でこのホスト名にポリシーを付ける、または'
    Write-Host '       ・.env.local の BASIC_AUTH_USER / BASIC_AUTH_PASS を設定して画面を再起動'
    Write-Host '       いまの管理者アカウントは admin / Admin 固定で、変更できない実装です。'
    Write-Host ''
  }

  'service-install' {
    if (-not (Test-Admin)) {
      Write-Host ''
      Write-Host '  この操作には管理者権限が必要です(右クリック →「管理者として実行」)。' -ForegroundColor Yellow
      Write-Host ''
      exit 1
    }
    Assert-Cloudflared
    if (-not (Test-Path $config)) {
      Write-Host ''
      Write-Host '  先に ops\tunnel-setup.cmd で固定URLの設定を作ってください。' -ForegroundColor Yellow
      Write-Host '  (quick 方式はURLが毎回変わるため、サービス化には向きません)' -ForegroundColor Yellow
      Write-Host ''
      exit 1
    }
    & $exe service install
    Start-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
    $svc = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host "  サービス化しました。状態: $($svc.Status)" -ForegroundColor Green
    Write-Host '  VPSを再起動しても自動で復帰します。'
    Write-Host '  ※ 画面(Next.js)側も自動起動にしておいてください … ops\install-tasks.cmd'
    Write-Host ''
  }

  'domain' {
    if (-not $Hostname) {
      Write-Host ''
      Write-Host '  確認したいホスト名を -Hostname で指定してください。' -ForegroundColor Yellow
      Write-Host '    例: ops\domain-check.cmd を実行して tenbai.a-step1.com と入力'
      Write-Host ''
      exit 1
    }
    $parts = $Hostname -split '\.'
    $zone = ($parts | Select-Object -Last 2) -join '.'

    Write-Host ''
    Write-Host "===== ドメインの接続状況: $Hostname =====" -ForegroundColor Cyan
    Write-Host ''

    # ① 権威ネームサーバーがCloudflareに移っているか
    #    お名前.com側でネームサーバーを変更してから、世界中に反映されるまで時間がかかる。
    #    ここが OK になるまで、次の手順に進んでも失敗する。
    $nsList = @()
    try {
      $nsList = @(Resolve-DnsName -Name $zone -Type NS -Server 8.8.8.8 -ErrorAction Stop |
        Where-Object { $_.NameHost } | ForEach-Object { $_.NameHost })
    } catch { }
    $onCloudflare = @($nsList | Where-Object { $_ -like '*ns.cloudflare.com' }).Count -gt 0
    Write-Check "$zone のネームサーバーがCloudflareになっている" $onCloudflare $(
      if ($nsList.Count -gt 0) { 'いま: ' + ($nsList -join ', ') } else { '引けませんでした' })
    if (-not $onCloudflare -and $nsList.Count -gt 0) {
      Write-Host '         → お名前.com Navi でネームサーバーを変更してください(反映に数時間〜48時間)' -ForegroundColor DarkGray
    }

    # ② メール(MX)が消えていないか。ネームサーバーを移すとゼロから作り直しになるので、
    #    ここが空だとメールが届かなくなる。移行前と同じ値が残っているかを見る。
    $mx = @()
    try {
      $mx = @(Resolve-DnsName -Name $zone -Type MX -Server 8.8.8.8 -ErrorAction Stop |
        Where-Object { $_.NameExchange } | ForEach-Object { $_.NameExchange })
    } catch { }
    Write-Check "$zone のメール(MX)が残っている" ($mx.Count -gt 0) $(
      if ($mx.Count -gt 0) { 'いま: ' + ($mx -join ', ') }
      else { 'MXが引けません。メールが止まります。CloudflareのDNSに mail50.onamae.ne.jp を入れ直してください' })

    # ③ 公開したいホスト名が引けるか
    $resolved = $null
    try {
      $resolved = @(Resolve-DnsName -Name $Hostname -Server 8.8.8.8 -ErrorAction Stop |
        Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress })
    } catch { }
    Write-Check "$Hostname が引ける" ($resolved -and $resolved.Count -gt 0) $(
      if ($resolved -and $resolved.Count -gt 0) { 'いま: ' + ($resolved -join ', ') + '（Cloudflareのアドレス）' }
      else { 'まだ作られていません。ops\tunnel-setup.cmd を実行してください' })

    # ④ 実際にHTTPSで開けるか。ここまで通れば、どの地域からでも開ける
    $reachable = $false
    $detail = ''
    try {
      $r = Invoke-WebRequest -Uri "https://$Hostname/login" -UseBasicParsing -TimeoutSec 20
      $reachable = ($r.StatusCode -eq 200)
      $detail = "HTTP $($r.StatusCode) / $($r.RawContentLength) バイト"
    } catch {
      $detail = "$($_.Exception.Message)"
    }
    Write-Check "https://$Hostname が応答する" $reachable $detail

    Write-Host ''
    if ($onCloudflare -and $reachable) {
      Write-Host "  完了しています。どの端末・どの地域からでも https://$Hostname で開けます。" -ForegroundColor Green
      Write-Host ''
      Write-Host '  ※ このURLは誰でもたどり着けます（証明書の記録から辿れます）。' -ForegroundColor Yellow
      Write-Host '    管理者アカウントは admin / Admin 固定のままなので、' -ForegroundColor Yellow
      Write-Host '    Cloudflare Access か BASIC_AUTH で手前を塞ぐことを強くおすすめします。' -ForegroundColor Yellow
    } else {
      Write-Host '  上の NG/-- の項目を上から順に片付けてください。' -ForegroundColor Cyan
    }
    Write-Host ''
  }

  'service-remove' {
    if (-not (Test-Admin)) {
      Write-Host ''
      Write-Host '  この操作には管理者権限が必要です(右クリック →「管理者として実行」)。' -ForegroundColor Yellow
      Write-Host ''
      exit 1
    }
    Assert-Cloudflared
    & $exe service uninstall
    Write-Host ''
    Write-Host '  サービスを削除しました。外部からは開けなくなります。' -ForegroundColor Green
    Write-Host ''
  }
}
