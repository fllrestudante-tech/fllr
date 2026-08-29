# Crypto10-Start.ps1 -- inicia o perfil "safe" do supervisor (monitoramento
# + coleta permitida, NUNCA o bot de trading), espera o dashboard ficar
# saudavel, e so entao abre o navegador. Fail-closed: qualquer bloqueio
# (identidade do repo, Node ausente, health nunca chega, banco ausente)
# encerra sem abrir navegador e sem deixar nada pendurado.
#
# Compatibilidade: Windows PowerShell 5.1. Nunca usa -ExecutionPolicy
# Bypass, Invoke-Expression, cmd /c, ou baixa nada.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)][int]$HealthTimeoutSec = 90,
    [Parameter(Mandatory = $false)][int]$PortDiscoveryTimeoutSec = 30,
    [Parameter(Mandatory = $false)][switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "Crypto10-Common.ps1")

function Exit-Crypto10Start {
    param([Parameter(Mandatory = $true)][int]$Code, [Parameter(Mandatory = $true)][string]$Message)
    if ($RepoRootForLog) {
        Write-Crypto10AutostartLog -RepoRoot $RepoRootForLog -Message $Message -Component "autostart"
    } else {
        Write-Host $Message
    }
    exit $Code
}

$RepoRootForLog = $null

try {
    # 1. Identidade do repositorio -- pelo caminho do PROPRIO script, nunca
    # aceitando um caminho externo sem validar.
    $RepoRoot = Resolve-Crypto10RepoRoot -ScriptRoot $PSScriptRoot
    $RepoRootForLog = $RepoRoot
    $identity = Test-Crypto10RepoIdentity -RepoRoot $RepoRoot
    if (-not $identity.IsValid) {
        Exit-Crypto10Start -Code 1 -Message "BLOQUEADO: identidade do repositorio invalida em '$RepoRoot' (marcadores ausentes: $($identity.MissingMarkers -join ', '); nome do pacote ok=$($identity.PackageNameOk)). Nada foi iniciado."
    }
    Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Identidade do repositorio confirmada em '$RepoRoot'."

    # 2. Node/npm confiaveis (via PATH, nunca baixados).
    $NodeExe = Find-Crypto10NodeExecutable
    if (-not $NodeExe) {
        Exit-Crypto10Start -Code 1 -Message "BLOQUEADO: node.exe nao encontrado no PATH. Nada foi iniciado."
    }
    $NpmExe = Find-Crypto10NpmExecutable
    if (-not $NpmExe) {
        Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "AVISO: npm nao encontrado no PATH (nao bloqueia -- este wrapper chama node diretamente em scripts\supervisor.js, nunca via npm)."
    }
    Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Node localizado: $NodeExe"

    $paths = Get-Crypto10RuntimePaths -RepoRoot $RepoRoot

    # 3/4. Supervisor ja ativo? Le o lock e VALIDA o PID contra o
    # commandline esperado -- nunca confia cegamente no numero do PID.
    # Lock ausente ou PID que nao bate com scripts\supervisor.js deste
    # repositorio -- nunca mata nada aqui; scripts/supervisor.js::
    # acquireLock() ja trata lock obsoleto com seguranca sozinho quando for
    # de fato reiniciado (ve/assume PID morto e sobrescreve o lock).
    $lock = Get-Crypto10SupervisorLock -RepoRoot $RepoRoot
    $alreadyRunning = $false
    if ($lock) {
        $check = Test-Crypto10ManagedProcess -ProcessId $lock.ProcessId -ExpectedScriptPath $paths.SupervisorScript
        if ($check.Exists -and $check.IsNode -and $check.MatchesScript) {
            $alreadyRunning = $true
            Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Supervisor ja ativo e validado (PID $($lock.ProcessId)) -- nao inicia uma segunda instancia."
        } else {
            Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Lock encontrado mas PID $($lock.ProcessId) nao corresponde a um supervisor.js valido deste repositorio (Exists=$($check.Exists) IsNode=$($check.IsNode) MatchesScript=$($check.MatchesScript)) -- tratado como obsoleto. Nenhum processo foi tocado; scripts/supervisor.js decide sozinho como lidar com o lock ao subir."
        }
    } else {
        Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Nenhum lock de supervisor encontrado."
    }

    if (-not $alreadyRunning) {
        # 5/6/7/8/9/10. Sobe scripts/supervisor.js DIRETAMENTE (nunca via
        # npm run, que passa por um wrapper .cmd adicional no Windows) com
        # SUPERVISOR_PROFILE=safe e TRADING_EXECUTION_ENABLED=false
        # sobrescritos no AMBIENTE DESTE PROCESSO antes do spawn -- o
        # filho herda exatamente esses dois valores, nunca os do usuario.
        # Os valores ORIGINAIS (mesmo se ausentes) sao salvos e restaurados
        # logo apos o spawn -- o filho ja herdou sua propria copia do
        # ambiente no momento da criacao (Start-Process/CreateProcess),
        # entao restaurar o ambiente DESTE processo depois nao o afeta, e
        # nenhuma variavel perigosa vaza pra comandos posteriores desta
        # mesma sessao PowerShell (ex.: se este script for dot-sourced em
        # vez de invocado standalone).
        $previousSupervisorProfile = $env:SUPERVISOR_PROFILE
        $previousTradingExecutionEnabled = $env:TRADING_EXECUTION_ENABLED
        $env:SUPERVISOR_PROFILE = "safe"
        $env:TRADING_EXECUTION_ENABLED = "false"

        $today = Get-Date -Format "yyyy-MM-dd"
        $logDir = Join-Path $paths.LogsDir $today
        if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
        # Nomeado "supervisor.out/err.log" (nao "supervisor.log") pra nunca
        # colidir com o log por-componente que scripts/supervisor.js ja
        # escreve pros FILHOS dele (lib/logRotation.js) -- isto aqui e so a
        # saida de topo do PROPRIO processo supervisor, que hoje so vai pro
        # terminal quando rodado interativamente.
        $outLog = Join-Path $logDir "supervisor.out.log"
        $errLog = Join-Path $logDir "supervisor.err.log"

        Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Iniciando scripts\supervisor.js (perfil safe, gate desligado) -- stdout/stderr em '$outLog' / '$errLog'."
        try {
            $started = Start-Process -FilePath $NodeExe -ArgumentList @("`"$($paths.SupervisorScript)`"") -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
            Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Supervisor iniciado (PID $($started.Id)). Independente deste wrapper -- continua rodando mesmo depois que este script terminar."
        } finally {
            # Restaura SEMPRE, mesmo se o spawn falhar -- nunca deixa o
            # ambiente deste processo com os valores forcados.
            if ($null -eq $previousSupervisorProfile) { Remove-Item Env:\SUPERVISOR_PROFILE -ErrorAction SilentlyContinue } else { $env:SUPERVISOR_PROFILE = $previousSupervisorProfile }
            if ($null -eq $previousTradingExecutionEnabled) { Remove-Item Env:\TRADING_EXECUTION_ENABLED -ErrorAction SilentlyContinue } else { $env:TRADING_EXECUTION_ENABLED = $previousTradingExecutionEnabled }
        }
    }

    # 11/12/13. Espera a porta real (do log do dashboard) e faz polling do
    # health ate aprovar ou estourar o timeout, com backoff limitado.
    Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Aguardando o dashboard publicar a porta (timeout ${PortDiscoveryTimeoutSec}s)..."
    $port = Get-Crypto10DashboardPortFromLog -RepoRoot $RepoRoot -TimeoutSec $PortDiscoveryTimeoutSec
    if (-not $port) {
        Exit-Crypto10Start -Code 1 -Message "FALHA: porta do dashboard nao apareceu no log dentro de ${PortDiscoveryTimeoutSec}s. Navegador NAO sera aberto. Diagnostico: rode Crypto10-Diagnose.ps1."
    }
    Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Porta do dashboard: $port. Aguardando health ficar pronto (timeout ${HealthTimeoutSec}s)..."

    $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
    $delayMs = 500
    $maxDelayMs = 5000
    $ready = $false
    $lastStatusCode = $null
    $lastReached = $false
    while ((Get-Date) -lt $deadline) {
        $health = Invoke-Crypto10HealthCheck -Port $port -NodeExe $NodeExe -RepoRoot $RepoRoot -TimeoutSec 3
        $lastStatusCode = $health.StatusCode
        $lastReached = $health.Reached
        if ($health.Ready) {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds $delayMs
        $delayMs = [Math]::Min($delayMs * 2, $maxDelayMs)
    }

    if (-not $ready) {
        Exit-Crypto10Start -Code 1 -Message "FALHA: health nunca ficou pronto dentro de ${HealthTimeoutSec}s (ultimo statusCode=$lastStatusCode, alcancado=$lastReached). Navegador NAO sera aberto. Diagnostico: rode Crypto10-Diagnose.ps1."
    }
    Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Health pronto (200, status=ok, mode=safe, tradingExecutionEnabled=false, database=ok)."

    # 14/15. Abre uma unica vez -- so depois de pronto, e so se ainda nao
    # tiver aberto pra esta MESMA instancia do supervisor (pid+startedAt do
    # lock atual). Nao ha como o Windows confirmar uma aba de navegador ja
    # aberta; esta e a medida confiavel disponivel: nunca reabre pra uma
    # instancia ja marcada.
    if ($NoBrowser) {
        Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Abertura do navegador pulada (-NoBrowser)."
    } else {
        $currentLock = Get-Crypto10SupervisorLock -RepoRoot $RepoRoot
        $alreadyOpened = $false
        if ($currentLock) {
            $alreadyOpened = Test-Crypto10BrowserAlreadyOpened -RepoRoot $RepoRoot -SupervisorProcessId $currentLock.ProcessId -StartedAt $currentLock.StartedAt
        }
        if ($alreadyOpened) {
            Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Navegador ja tinha sido aberto pra esta instancia do supervisor -- nao abre de novo."
        } else {
            $url = "http://127.0.0.1:$port/"
            Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Abrindo o dashboard em $url"
            Start-Process $url | Out-Null
            if ($currentLock) {
                Set-Crypto10BrowserOpenedMarker -RepoRoot $RepoRoot -SupervisorProcessId $currentLock.ProcessId -StartedAt $currentLock.StartedAt
            }
        }
    }

    Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Crypto10-Start.ps1 concluido com sucesso."
    exit 0
} catch {
    $msg = "ERRO INESPERADO em Crypto10-Start.ps1: $($_.Exception.Message)"
    if ($RepoRootForLog) {
        Write-Crypto10AutostartLog -RepoRoot $RepoRootForLog -Message $msg -Component "autostart"
    } else {
        Write-Host $msg
    }
    exit 1
}
