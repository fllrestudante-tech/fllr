# Crypto10-Common.ps1 -- funcoes compartilhadas por Start/Stop/Status/
# Diagnose. Dot-source este arquivo (". .\Crypto10-Common.ps1"); ele nunca
# executa nada por conta propria alem de DEFINIR funcoes/constantes.
#
# Compatibilidade: escrito para o Windows PowerShell 5.1 que ja vem com o
# Windows -- sem operador ternario, sem null-coalescing (??/?.), sem
# `&&`/`||` de encadeamento de comando, sem classes, sem recursos
# exclusivos do PowerShell 7. Nunca usa -ExecutionPolicy Bypass,
# Invoke-Expression, cmd /c ou download de ferramentas.

Set-StrictMode -Version Latest

# Marcadores que precisam existir pra confirmar que $RepoRoot e de fato
# este repositorio -- nunca um caminho fornecido sem validacao, nunca outro
# clone do projeto em outro disco. Commits futuros vao mudar o HEAD; por
# isso a identidade e validada por ESTRUTURA (arquivos + nome do pacote),
# nunca por hash de commit fixo.
$Script:Crypto10RepoMarkers = @(
    "package.json",
    "scripts\supervisor.js",
    "lib\supervisorProfile.js",
    "lib\tradingExecutionGate.js",
    "scripts\dashboardServer.js"
)
$Script:Crypto10ExpectedPackageName = "bot-cripto10"

function Resolve-Crypto10RepoRoot {
    <#
    .SYNOPSIS
    Resolve o diretorio do projeto a partir da localizacao do PROPRIO
    script (scripts\autostart\*.ps1) -- nunca de um caminho externo sem
    validacao, nunca procurando outras copias em outros discos.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$ScriptRoot
    )
    $candidate = Split-Path -Path (Split-Path -Path $ScriptRoot -Parent) -Parent
    return [System.IO.Path]::GetFullPath($candidate)
}

function Test-Crypto10RepoIdentity {
    <#
    .SYNOPSIS
    Confirma que $RepoRoot tem todos os marcadores esperados E que
    package.json declara o nome esperado do pacote (quando legivel).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot
    )
    $missing = New-Object System.Collections.Generic.List[string]
    foreach ($marker in $Script:Crypto10RepoMarkers) {
        $full = Join-Path -Path $RepoRoot -ChildPath $marker
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            $missing.Add($marker)
        }
    }

    $packageNameOk = $true
    $packageJsonPath = Join-Path -Path $RepoRoot -ChildPath "package.json"
    if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
        try {
            $pkg = Get-Content -LiteralPath $packageJsonPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            if ($pkg.name -ne $Script:Crypto10ExpectedPackageName) {
                $packageNameOk = $false
            }
        } catch {
            $packageNameOk = $false
        }
    }

    $isValid = ($missing.Count -eq 0) -and $packageNameOk
    return [PSCustomObject]@{
        IsValid        = $isValid
        MissingMarkers = @($missing)
        PackageNameOk  = $packageNameOk
        RepoRoot       = $RepoRoot
    }
}

function Find-Crypto10Executable {
    <#
    .SYNOPSIS
    Localiza um executavel confiavel via PATH (Get-Command), nunca baixa
    nada, nunca assume um caminho fixo. Devolve $null se ausente -- quem
    chama decide o comportamento fail-closed.
    #>
    param(
        [Parameter(Mandatory = $true)][string[]]$CandidateNames
    )
    foreach ($name in $CandidateNames) {
        $cmd = Get-Command -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source -PathType Leaf)) {
            return [System.IO.Path]::GetFullPath($cmd.Source)
        }
    }
    return $null
}

function Find-Crypto10NodeExecutable {
    return Find-Crypto10Executable -CandidateNames @("node.exe", "node")
}

function Find-Crypto10NpmExecutable {
    return Find-Crypto10Executable -CandidateNames @("npm.cmd", "npm")
}

function Get-Crypto10RuntimePaths {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot
    )
    $runtimeDir = Join-Path $RepoRoot "runtime"
    return [PSCustomObject]@{
        RuntimeDir        = $runtimeDir
        LockFile          = Join-Path $runtimeDir "locks\supervisor.lock"
        PidsDir           = Join-Path $runtimeDir "pids"
        AutostartDir      = Join-Path $runtimeDir "autostart"
        BrowserMarkerFile = Join-Path $runtimeDir "autostart\browser-opened.json"
        LogsDir           = Join-Path $RepoRoot "logs"
        SupervisorScript  = Join-Path $RepoRoot "scripts\supervisor.js"
        DashboardScript   = Join-Path $RepoRoot "scripts\dashboardServer.js"
        DataDir           = Join-Path $RepoRoot "data"
        MarketDbPath      = Join-Path $RepoRoot "data\market.db"
    }
}

function Get-Crypto10SupervisorLock {
    <#
    .SYNOPSIS
    Le runtime\locks\supervisor.lock ({pid, startedAt}, o mesmo formato ja
    escrito por scripts/supervisor.js::acquireLock). Devolve $null se
    ausente ou ilegivel -- nunca lanca.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot
    )
    $paths = Get-Crypto10RuntimePaths -RepoRoot $RepoRoot
    if (-not (Test-Path -LiteralPath $paths.LockFile -PathType Leaf)) {
        return $null
    }
    try {
        $raw = Get-Content -LiteralPath $paths.LockFile -Raw -ErrorAction Stop
        $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
        return [PSCustomObject]@{
            ProcessId = [int]$parsed.pid
            StartedAt = [string]$parsed.startedAt
        }
    } catch {
        return $null
    }
}

function Get-Crypto10ProcessLookup {
    <#
    .SYNOPSIS
    Lookup PADRAO de processo via CIM/WMI (nativo do Windows, nenhuma
    dependencia nova). Devolve $null se o PID nao existir. Separado numa
    funcao propria so pra poder ser substituida por um fake nos testes
    (parametro -Lookup em Test-Crypto10ManagedProcess).
    #>
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId
    )
    try {
        $proc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    } catch {
        return $null
    }
    if (-not $proc) { return $null }
    $cmdLine = ""
    if ($proc.CommandLine) { $cmdLine = [string]$proc.CommandLine }
    return [PSCustomObject]@{
        ProcessId   = [int]$proc.ProcessId
        Name        = [string]$proc.Name
        CommandLine = $cmdLine
    }
}

function Test-Crypto10ManagedProcess {
    <#
    .SYNOPSIS
    Confirma que $ProcessId e de fato node.exe rodando $ExpectedScriptPath
    (caminho absoluto ja resolvido) -- nunca aceita PID inexistente, PID
    reaproveitado por outro processo, ou node.exe de outro script/projeto.
    #>
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$ExpectedScriptPath,
        [Parameter(Mandatory = $false)][scriptblock]$Lookup = ${function:Get-Crypto10ProcessLookup}
    )
    $info = & $Lookup -ProcessId $ProcessId
    if (-not $info) {
        return [PSCustomObject]@{ Exists = $false; IsNode = $false; MatchesScript = $false; ProcessId = $ProcessId }
    }
    $isNode = $info.Name -ieq "node.exe"
    $normalizedExpected = $ExpectedScriptPath.ToLowerInvariant()
    $normalizedCmd = ""
    if ($info.CommandLine) { $normalizedCmd = $info.CommandLine.ToLowerInvariant() }
    $matchesScript = $isNode -and $normalizedCmd.Contains($normalizedExpected)
    return [PSCustomObject]@{
        Exists        = $true
        IsNode        = $isNode
        MatchesScript = $matchesScript
        ProcessId     = $ProcessId
    }
}

function Invoke-Crypto10NodeScript {
    <#
    .SYNOPSIS
    Roda um arquivo .js com o Node localizado, sem shell (UseShellExecute
    = $false, sem cmd /c, sem Invoke-Expression). Devolve ExitCode/StdOut/
    StdErr. Usado pra reaproveitar logica pura ja testada em lib/autostart/
    (health readiness, lista de processos seguros) sem reimplementa-la em
    PowerShell.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$NodeExe,
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $false)][string]$StdinText = $null,
        [Parameter(Mandatory = $false)][string]$WorkingDirectory = $null,
        [Parameter(Mandatory = $false)][int]$TimeoutMs = 10000
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $NodeExe
    # .Arguments (string), nao .ArgumentList -- nem toda instalacao de
    # Windows PowerShell 5.1 expoe ArgumentList na versao carregada de
    # System.Diagnostics.ProcessStartInfo; .Arguments existe desde sempre.
    # $ScriptPath vem sempre de Join-Path desta mesma funcao/modulo (nunca
    # entrada de usuario), entao aspas simples ao redor bastam.
    $psi.Arguments = '"' + $ScriptPath + '"'
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }

    $proc = [System.Diagnostics.Process]::Start($psi)
    if ($null -ne $StdinText) {
        # NOTA (achado real testando o fluxo de ponta a ponta nesta
        # rodada): o .NET Framework usado pelo Windows PowerShell 5.1
        # injeta um BOM UTF-8 automaticamente ao acessar Process.
        # StandardInput -- mesmo escrevendo bytes crus direto em
        # .BaseStream (testado e confirmado), e `StandardInputEncoding`
        # nem existe nesta versao pra configurar isso na origem. Em vez de
        # lutar contra essa camada, os CLIs do lado do Node (lib/autostart/
        # *Cli.js) descartam um BOM inicial se presente -- mais simples e
        # robusto do que tentar impedir o BOM aqui.
        $proc.StandardInput.Write($StdinText)
    }
    $proc.StandardInput.Close()
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $exited = $proc.WaitForExit($TimeoutMs)
    if (-not $exited) {
        try { $proc.Kill() } catch {}
        return [PSCustomObject]@{ ExitCode = -1; StdOut = $stdout; StdErr = "timeout"; TimedOut = $true }
    }
    return [PSCustomObject]@{ ExitCode = $proc.ExitCode; StdOut = $stdout; StdErr = $stderr; TimedOut = $false }
}

function Get-Crypto10SafeChildrenSummary {
    <#
    .SYNOPSIS
    Chama lib/autostart/childrenSummaryCli.js -- fonte unica dos processos
    do perfil seguro, nunca uma segunda lista hardcoded em PowerShell.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$NodeExe,
        [Parameter(Mandatory = $true)][string]$RepoRoot
    )
    $cliPath = Join-Path $RepoRoot "lib\autostart\childrenSummaryCli.js"
    $result = Invoke-Crypto10NodeScript -NodeExe $NodeExe -ScriptPath $cliPath -WorkingDirectory $RepoRoot
    if ($result.ExitCode -ne 0 -or $result.TimedOut) {
        return $null
    }
    try {
        return $result.StdOut | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $null
    }
}

function Invoke-Crypto10HealthCheck {
    <#
    .SYNOPSIS
    GET http://127.0.0.1:<port>/api/v1/health e devolve a decisao de
    prontidao usando a MESMA logica testada de
    lib/autostart/healthReadiness.js (via CLI) -- nunca reimplementa o
    criterio de aceitacao em PowerShell.
    #>
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$NodeExe,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $false)][int]$TimeoutSec = 3,
        # "safe" (default, retrocompativel) ou "demo_observe" -- selecionado
        # pelo chamador de acordo com o -SupervisorProfile/-DemoExecutionMode
        # que este MESMO wrapper pediu pro supervisor. Repassado como
        # `expectedMode` no payload JSON pra lib/autostart/healthReadinessCli.js,
        # que usa lib/autostart/healthReadiness.js::isHealthResponseReady --
        # nunca reimplementa o criterio aqui.
        [Parameter(Mandatory = $false)][string]$ExpectedMode = "safe"
    )
    $url = "http://127.0.0.1:$Port/api/v1/health"
    $statusCode = $null
    $bodyText = $null
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $TimeoutSec -Method Get -ErrorAction Stop
        $statusCode = [int]$response.StatusCode
        $bodyText = [string]$response.Content
    } catch {
        $webResponse = $null
        if ($_.Exception -and $_.Exception.PSObject.Properties.Match("Response").Count -gt 0) {
            $webResponse = $_.Exception.Response
        }
        if ($webResponse) {
            try {
                $statusCode = [int]$webResponse.StatusCode
                $stream = $webResponse.GetResponseStream()
                $reader = New-Object System.IO.StreamReader($stream)
                $bodyText = $reader.ReadToEnd()
            } catch {
                $statusCode = $null
            }
        }
    }

    if ($null -eq $statusCode) {
        return [PSCustomObject]@{ Reached = $false; Ready = $false; StatusCode = $null; Body = $null }
    }

    $bodyObject = $null
    if ($bodyText) {
        try { $bodyObject = $bodyText | ConvertFrom-Json -ErrorAction Stop } catch { $bodyObject = $null }
    }

    $payloadObject = @{ statusCode = $statusCode; body = $bodyObject; expectedMode = $ExpectedMode }
    $payloadJson = $payloadObject | ConvertTo-Json -Compress -Depth 6
    $cliPath = Join-Path $RepoRoot "lib\autostart\healthReadinessCli.js"
    $cliResult = Invoke-Crypto10NodeScript -NodeExe $NodeExe -ScriptPath $cliPath -StdinText $payloadJson -WorkingDirectory $RepoRoot
    $ready = $false
    if (-not $cliResult.TimedOut -and $cliResult.StdOut.Trim() -eq "true") {
        $ready = $true
    }

    return [PSCustomObject]@{ Reached = $true; Ready = $ready; StatusCode = $statusCode; Body = $bodyObject }
}

function Get-Crypto10DashboardPortFromLog {
    <#
    .SYNOPSIS
    Le a porta REAL em que o dashboard subiu, direto do log rotacionado
    que scripts/supervisor.js ja escreve pra dashboard_server (logs\<data>\
    dashboard_server.log) -- nunca reimplementa a validacao estrita de
    porta (lib/webDashboard/dashboardBindConfig.js) numa segunda copia em
    PowerShell; so observa o que o processo real efetivamente fez.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $false)][int]$TimeoutSec = 30,
        [Parameter(Mandatory = $false)][int]$PollIntervalMs = 500
    )
    $paths = Get-Crypto10RuntimePaths -RepoRoot $RepoRoot
    $pattern = [regex]"Dashboard Operacional em http://127\.0\.0\.1:(\d+)"
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        # UTC explicito -- MESMA convencao de lib/logRotation.js:13
        # (toISOString().slice(0,10), tambem UTC). Antes desta rodada isto
        # usava hora LOCAL, o que fazia esta funcao procurar na pasta ERRADA
        # durante a janela em que data local != data UTC (ex.: ~21h-24h em
        # UTC-3) -- bug real, nao so estetico.
        $today = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
        $logPath = Join-Path $paths.LogsDir (Join-Path $today "dashboard_server.log")
        if (Test-Path -LiteralPath $logPath -PathType Leaf) {
            $content = $null
            try { $content = Get-Content -LiteralPath $logPath -Raw -ErrorAction Stop } catch { $content = $null }
            if ($content) {
                $m = $pattern.Match($content)
                if ($m.Success) {
                    return [int]$m.Groups[1].Value
                }
            }
        }
        Start-Sleep -Milliseconds $PollIntervalMs
    }
    return $null
}

function Write-Crypto10AutostartLog {
    <#
    .SYNOPSIS
    Log do proprio wrapper -- MESMA convencao de diretorio ja usada por
    lib/logRotation.js (logs\<data>\<componente>.log), so reaproveitada
    aqui em vez de inventar um esquema novo.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$Message,
        [Parameter(Mandatory = $false)][string]$Component = "autostart",
        [Parameter(Mandatory = $false)][switch]$NoConsole
    )
    # UTC explicito com "Z" em pasta E timestamp -- MESMA convencao de
    # lib/logRotation.js (ver comentario daquele arquivo). Nunca hora local
    # (antes desta rodada, autostart.log usava local+offset enquanto os logs
    # por-componente do Node ja usavam UTC -- mistura silenciosa de fuso
    # entre arquivos do mesmo dia).
    $today = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
    $dir = Join-Path (Join-Path $RepoRoot "logs") $today
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $logPath = Join-Path $dir "$Component.log"
    $timestamp = (Get-Date).ToUniversalTime().ToString("o")
    Add-Content -LiteralPath $logPath -Value "[$timestamp] $Message"
    if (-not $NoConsole) {
        Write-Host $Message
    }
}

function Get-Crypto10SupervisorRunLogPaths {
    <#
    .SYNOPSIS
    Devolve caminhos de log POR EXECUCAO pro stdout/stderr do processo
    supervisor.js de topo (Start-Process -RedirectStandardOutput/-Error) --
    nunca o nome fixo "supervisor.out.log"/"supervisor.err.log" de antes
    desta rodada, que Start-Process RECRIA (trunca) a cada novo lancamento,
    apagando silenciosamente o erro da execucao anterior (achado real de
    uma auditoria de crash-loop: o log que teria a causa exata da falha do
    "bot" foi perdido assim). Nome inclui timestamp com milissegundos
    (nunca colide entre execucoes na mesma sessao) + um sufixo aleatorio
    curto (nunca colide mesmo se duas execucoes comecarem no mesmo
    milissegundo, ex.: duas instancias do wrapper disparadas quase juntas).
    Retencao: mantem só as `$RetentionCount` execucoes mais recentes (par
    out+err junto) NESTE diretorio de log do dia -- apaga o excedente MAIS
    ANTIGO antes de devolver os caminhos novos, nunca depois (nunca deixa
    a pasta crescer sem limite, mas sempre preserva o suficiente pra
    diagnosticar a execucao anterior antes de qualquer limpeza).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$LogDir,
        [Parameter(Mandatory = $false)][int]$RetentionCount = 8
    )
    if (-not (Test-Path -LiteralPath $LogDir)) {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }

    # @(...) forca array mesmo com 0/1 resultado -- sem isto, Get-ChildItem
    # com exatamente 1 arquivo devolve um FileInfo solto (sem propriedade
    # .Count), o que quebra sob Set-StrictMode (achado real rodando os
    # testes desta rodada).
    $existingOut = @(Get-ChildItem -LiteralPath $LogDir -Filter "supervisor.out.*.log" -File -ErrorAction SilentlyContinue | Sort-Object Name)
    if ($existingOut.Count -ge $RetentionCount) {
        $excess = $existingOut.Count - $RetentionCount + 1
        $toRemove = $existingOut | Select-Object -First $excess
        foreach ($old in $toRemove) {
            $errCounterpart = Join-Path $LogDir ($old.Name -replace '^supervisor\.out\.', 'supervisor.err.')
            Remove-Item -LiteralPath $old.FullName -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $errCounterpart -Force -ErrorAction SilentlyContinue
        }
    }

    # UTC explicito -- "Z" anexado como sufixo literal (nao ha specifier de
    # formato custom nativo do .NET pra isso fora do formato round-trip "o").
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmssfff") + "Z"
    $suffix = -join ((48..57 + 97..122) | Get-Random -Count 4 | ForEach-Object { [char]$_ })
    return [PSCustomObject]@{
        OutLog = Join-Path $LogDir "supervisor.out.$stamp-$suffix.log"
        ErrLog = Join-Path $LogDir "supervisor.err.$stamp-$suffix.log"
    }
}

function Get-Crypto10PortOccupant {
    <#
    .SYNOPSIS
    Confirma se $Port esta ocupada (LISTEN) e, se estiver, identifica o
    processo dono -- SEM jamais encerra-lo. Via Get-NetTCPConnection
    (modulo NetTCPIP, nativo do Windows 8+/Server 2012+, nenhuma
    dependencia nova).
    #>
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $false)][scriptblock]$ConnectionLookup = $null,
        [Parameter(Mandatory = $false)][scriptblock]$Lookup = ${function:Get-Crypto10ProcessLookup}
    )
    $conn = $null
    if ($ConnectionLookup) {
        $conn = & $ConnectionLookup -Port $Port
    } else {
        try {
            $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        } catch {
            $conn = $null
        }
    }
    if (-not $conn) {
        return [PSCustomObject]@{ Occupied = $false; ProcessId = $null; ProcessName = $null }
    }
    $info = & $Lookup -ProcessId ([int]$conn.OwningProcess)
    if ($info) {
        return [PSCustomObject]@{ Occupied = $true; ProcessId = $info.ProcessId; ProcessName = $info.Name }
    }
    return [PSCustomObject]@{ Occupied = $true; ProcessId = [int]$conn.OwningProcess; ProcessName = $null }
}

function Test-Crypto10BrowserAlreadyOpened {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][int]$SupervisorProcessId,
        [Parameter(Mandatory = $true)][string]$StartedAt
    )
    $paths = Get-Crypto10RuntimePaths -RepoRoot $RepoRoot
    if (-not (Test-Path -LiteralPath $paths.BrowserMarkerFile -PathType Leaf)) {
        return $false
    }
    try {
        $marker = Get-Content -LiteralPath $paths.BrowserMarkerFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $false
    }
    return ([int]$marker.pid -eq $SupervisorProcessId) -and ([string]$marker.startedAt -eq $StartedAt)
}

function Set-Crypto10BrowserOpenedMarker {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][int]$SupervisorProcessId,
        [Parameter(Mandatory = $true)][string]$StartedAt
    )
    $paths = Get-Crypto10RuntimePaths -RepoRoot $RepoRoot
    if (-not (Test-Path -LiteralPath $paths.AutostartDir)) {
        New-Item -ItemType Directory -Path $paths.AutostartDir -Force | Out-Null
    }
    $marker = @{ pid = $SupervisorProcessId; startedAt = $StartedAt; openedAt = (Get-Date).ToUniversalTime().ToString("o") }
    $marker | ConvertTo-Json | Set-Content -LiteralPath $paths.BrowserMarkerFile
}
