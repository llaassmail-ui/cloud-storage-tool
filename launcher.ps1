param([switch]$Restart, [switch]$NoBrowser, [switch]$Yes)
$ErrorActionPreference = 'Stop'
$toolRoot = (Get-Location).Path
$serverFile = Join-Path $toolRoot 'server.js'
$settingsFile = Join-Path $toolRoot '.launcher-port'
$toolProcess = $null
$lockTaken = $false

function Get-Listener($portNumber) {
    @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $portNumber)
}

function Get-OwnedProcess($portNumber) {
    $listeners = @(Get-Listener $portNumber)
    if (!$listeners.Count) { return $null }
    $owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -ne 1) { throw "端口 $portNumber 被其他程序占用，未停止任何进程。" }
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($owners[0])"
    if (!$processInfo) { throw "端口 $portNumber 的所属进程无法确认，未停止任何进程。" }
    # Require the exact absolute entrypoint. Never kill a process just because it owns a port.
    $quotedPath = [regex]::Escape('"' + $serverFile + '"')
    $absolutePath = [regex]::Escape($serverFile)
    $matchesEntrypoint = $processInfo.CommandLine -match ("(?:^|\s)" + $quotedPath + '\s*$') -or
        $processInfo.CommandLine -match ("(?:^|\s)" + $absolutePath + '\s*$')
    if ($processInfo.Name -ne 'node.exe' -or !$matchesEntrypoint) {
        throw "端口 $portNumber 已占用，但无法确认它属于此目录。请关闭旧版工具的启动窗口后再双击；未停止任何其他程序。"
    }
    return $processInfo
}

function Get-LocalGoogleProxy {
    $coreNames = '^(xray|v2ray|v2rayn|clash|mihomo|sing-box|nekoray)$'
    foreach ($port in @(10808, 10809, 7890, 7891, 1080)) {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
        foreach ($listener in $listeners) {
            if ($listener.LocalAddress -notin @('127.0.0.1', '0.0.0.0', '::1', '::')) { continue }
            $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
            if ($owner -and $owner.ProcessName -match $coreNames) {
                return "http://127.0.0.1:$port"
            }
        }
    }
    return $null
}

try {
    if (!(Test-Path -LiteralPath $serverFile)) { throw '请将工具完整解压后，在工具文件夹中双击启动或重启。' }
    $portNumber = 8787
    if (Test-Path -LiteralPath $settingsFile) { $portNumber = [int]([IO.File]::ReadAllText($settingsFile).Trim()) }
    if ($env:PORT) { $portNumber = [int]$env:PORT }
    if ($portNumber -lt 1024 -or $portNumber -gt 65535) { throw '端口必须在 1024 到 65535 之间。' }
    # On first launch, leave legacy instances and other applications running.
    if (!$env:PORT -and !(Test-Path -LiteralPath $settingsFile)) {
        while (@(Get-Listener $portNumber).Count) {
            try { if (Get-OwnedProcess $portNumber) { break } } catch { }
            $portNumber++
            if ($portNumber -gt 8887) { throw '没有找到可用端口，请关闭不再使用的工具后重试。' }
        }
    }
    $mutex = New-Object Threading.Mutex($false, "Local\AwsStorageToolLauncher-$portNumber")
    $lockTaken = $mutex.WaitOne(0)
    if (!$lockTaken) { throw '工具正在启动或重启，请稍候，不必重复双击。' }
    $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (!$nodePath) { throw '尚未安装 Node.js。请从 https://nodejs.org 安装 Node.js 22 或更新版本，然后再次双击。' }
    $nodeVersion = & $nodePath -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.Split('.')[0]) -lt 22) { throw '请安装 Node.js 22 或更新版本。' }
    $hasConfiguredProxy = ![string]::IsNullOrWhiteSpace($env:HTTPS_PROXY) -or ![string]::IsNullOrWhiteSpace($env:HTTP_PROXY)
    if (!$hasConfiguredProxy) {
        $localProxy = Get-LocalGoogleProxy
        if ($localProxy) {
            $env:HTTPS_PROXY = $localProxy
            Write-Host '检测到 V2Ray/Xray 本地代理；Google Cloud 请求将通过该代理连接。'
        }
    }
    $current = Get-OwnedProcess $portNumber
    if ($Restart -and $current -and !$Yes) {
        Add-Type -AssemblyName System.Windows.Forms
        $answer = [Windows.Forms.MessageBox]::Show("重启会中断正在执行的上传、复制和移动，清空连接及任务记录，需要重新输入密钥。已提交的 CDN 失效不会撤销。`n`n请确认任务已结束。现在重启？", '重启云存储与 CDN 工具', 'YesNo', 'Warning', 'Button2')
        if ($answer -ne 'Yes') { return }
    }
    if (!$current -or $Restart) {
        # Check dependencies before stopping a working instance.
        if (!(Test-Path -LiteralPath (Join-Path $toolRoot 'node_modules/@aws-sdk/client-s3/package.json')) -or !(Test-Path -LiteralPath (Join-Path $toolRoot 'node_modules/@google-cloud/storage/package.json')) -or !(Test-Path -LiteralPath (Join-Path $toolRoot 'node_modules/google-auth-library/package.json'))) {
            Write-Host '首次启动，正在安装依赖，请稍候…'
            & npm.cmd ci --ignore-scripts
            if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。请检查网络后重新双击启动。' }
        }
        if ($current) {
            $verified = Get-OwnedProcess $portNumber
            if (!$verified -or $verified.ProcessId -ne $current.ProcessId -or $verified.CreationDate -ne $current.CreationDate) { throw '进程状态已变化，请重新操作。' }
            Stop-Process -Id $current.ProcessId -ErrorAction Stop
            Wait-Process -Id $current.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
        }
        $env:PORT = "$portNumber"
        $toolProcess = Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverFile + '"') -WorkingDirectory $toolRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $toolRoot 'tool.stdout.log') -RedirectStandardError (Join-Path $toolRoot 'tool.stderr.log') -PassThru
    }
    $address = "http://127.0.0.1:$portNumber/"
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($toolProcess -and $toolProcess.HasExited) { throw '工具启动失败，请查看工具文件夹中的 tool.stderr.log。' }
        try {
            $response = Invoke-WebRequest -Uri $address -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                $owner = Get-OwnedProcess $portNumber
                if ($owner -and (!$toolProcess -or $owner.ProcessId -eq $toolProcess.Id)) { $ready = $true; break }
            }
        } catch { }
        Start-Sleep -Milliseconds 300
    }
    if (!$ready) { throw '启动超时。请检查 tool.stderr.log 后重试。' }
    [IO.File]::WriteAllText($settingsFile, "$portNumber", [Text.Encoding]::ASCII)
    Write-Host "工具已就绪：$address"
    if (!$NoBrowser) {
        try { Start-Process $address } catch { Write-Host "浏览器未能自动打开，请访问：$address" }
    }
} catch {
    if ($toolProcess -and !$toolProcess.HasExited) { $toolProcess.Kill() }
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($lockTaken) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
