# Crypto10-Status.ps1 -- somente leitura. Nunca inicia, encerra ou altera
# nada. Exit code != 0 quando o dashboard nao estiver pronto (perfil safe +
# gate desligado + banco ok), pra poder ser usado em automacao futura.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "Crypto10-Common.ps1")

$RepoRoot = Resolve-Crypto10RepoRoot -ScriptRoot $PSScriptRoot
$identity = Test-Crypto10RepoIdentity -RepoRoot $RepoRoot
if (-not $identity.IsValid) {
    Write-Host "identidade_repositorio: INVALIDA (marcadores ausentes: $($identity.MissingMarkers -join ', '))"
    exit 2
}
Write-Host "identidade_repositorio: ok ($RepoRoot)"

$paths = Get-Crypto10RuntimePaths -RepoRoot $RepoRoot
$NodeExe = Find-Crypto10NodeExecutable

$lock = Get-Crypto10SupervisorLock -RepoRoot $RepoRoot
$supervisorAtivo = $false
$supervisorPid = $null
if ($lock -and $NodeExe) {
    $check = Test-Crypto10ManagedProcess -ProcessId $lock.ProcessId -ExpectedScriptPath $paths.SupervisorScript
    if ($check.Exists -and $check.IsNode -and $check.MatchesScript) {
        $supervisorAtivo = $true
        $supervisorPid = $lock.ProcessId
    }
}
Write-Host "supervisor_ativo: $supervisorAtivo"
Write-Host "supervisor_pid_validado: $(if ($supervisorPid) { $supervisorPid } else { 'nenhum' })"
Write-Host "perfil_esperado: safe"
Write-Host "gate_financeiro_esperado: desligado (TRADING_EXECUTION_ENABLED=false)"

$safeSummary = $null
if ($NodeExe) { $safeSummary = Get-Crypto10SafeChildrenSummary -NodeExe $NodeExe -RepoRoot $RepoRoot }
if ($safeSummary) {
    $names = $safeSummary.safe.children | ForEach-Object { $_.name }
    Write-Host "componentes_seguros_esperados: $($names -join ', ')"
} else {
    Write-Host "componentes_seguros_esperados: (nao foi possivel calcular -- node ausente ou childrenSummaryCli falhou)"
}

$port = $null
$healthReached = $false
$healthReady = $false
$healthStatusCode = $null
$healthBody = $null
if ($supervisorAtivo -and $NodeExe) {
    $port = Get-Crypto10DashboardPortFromLog -RepoRoot $RepoRoot -TimeoutSec 2 -PollIntervalMs 250
    if ($port) {
        $health = Invoke-Crypto10HealthCheck -Port $port -NodeExe $NodeExe -RepoRoot $RepoRoot -TimeoutSec 3
        $healthReached = $health.Reached
        $healthReady = $health.Ready
        $healthStatusCode = $health.StatusCode
        $healthBody = $health.Body
    }
}
Write-Host "porta: $(if ($port) { $port } else { 'desconhecida (dashboard ainda nao publicou, ou supervisor inativo)' })"
if ($port) {
    Write-Host "url_local: http://127.0.0.1:$port/"
} else {
    Write-Host "url_local: (indisponivel)"
}
Write-Host "health_http_status: $(if ($healthStatusCode) { $healthStatusCode } else { 'sem resposta' })"
Write-Host "dashboard_pronto: $healthReady"
if ($healthBody) {
    Write-Host "health_mode: $($healthBody.mode)"
    Write-Host "health_tradingExecutionEnabled: $($healthBody.tradingExecutionEnabled)"
    Write-Host "health_database: $($healthBody.database)"
}

# Locks/PIDs obsoletos -- so LEITURA, nunca remove/toca em nada aqui.
$staleEntries = New-Object System.Collections.Generic.List[string]
if ($lock -and -not $supervisorAtivo) {
    $staleEntries.Add("runtime\locks\supervisor.lock (PID $($lock.ProcessId) nao valida)")
}
if (Test-Path -LiteralPath $paths.PidsDir -PathType Container) {
    $pidFiles = Get-ChildItem -LiteralPath $paths.PidsDir -Filter "*.pid" -File -ErrorAction SilentlyContinue
    foreach ($pidFile in $pidFiles) {
        $raw = (Get-Content -LiteralPath $pidFile.FullName -Raw -ErrorAction SilentlyContinue)
        $candidatePid = 0
        if ([int]::TryParse((($raw -as [string])).Trim(), [ref]$candidatePid)) {
            $info = Get-Crypto10ProcessLookup -ProcessId $candidatePid
            if (-not $info) {
                $staleEntries.Add("runtime\pids\$($pidFile.Name) (PID $candidatePid nao existe)")
            }
        }
    }
}
if ($staleEntries.Count -gt 0) {
    Write-Host "locks_pids_obsoletos: $($staleEntries -join ' | ')"
} else {
    Write-Host "locks_pids_obsoletos: nenhum"
}

# Ultimo erro sanitizado -- so a ultima linha FALHA/BLOQUEADO/ERRO do log
# do proprio wrapper (mensagens ja controladas por Write-Crypto10AutostartLog,
# nunca dump cru de excecao/segredo).
$lastError = $null
# UTC explicito -- mesma convencao de Write-Crypto10AutostartLog (que grava
# a pasta), senao esta leitura procura no dia errado perto da meia-noite.
$today = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
$autostartLog = Join-Path $paths.LogsDir (Join-Path $today "autostart.log")
if (Test-Path -LiteralPath $autostartLog -PathType Leaf) {
    $lines = Get-Content -LiteralPath $autostartLog -ErrorAction SilentlyContinue
    # @(...) forca array mesmo com 1 resultado -- sem isso, Where-Object
    # com exatamente 1 match devolve uma STRING escalar, e [-1] nela pega
    # o ULTIMO CARACTERE da linha, nao a ultima linha (bug real encontrado
    # testando esta rodada).
    $errorLines = @($lines | Where-Object { $_ -match "FALHA|BLOQUEADO|RECUSADO|ERRO" })
    if ($errorLines.Count -gt 0) { $lastError = $errorLines[-1] }
}
Write-Host "ultimo_erro: $(if ($lastError) { $lastError } else { 'nenhum registrado hoje' })"

if ($supervisorAtivo -and $healthReady) {
    exit 0
} else {
    exit 1
}
