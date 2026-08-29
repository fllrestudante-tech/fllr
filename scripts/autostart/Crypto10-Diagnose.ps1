# Crypto10-Diagnose.ps1 -- SOMENTE LEITURA. Nunca inicia, encerra, altera
# ou repara nada. Nunca mostra valor de variavel, token, caminho
# confidencial ou conteudo do .env -- so presenca/ausencia de nomes e
# estados publicos seguros.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

. (Join-Path $PSScriptRoot "Crypto10-Common.ps1")

Write-Host "=== Crypto10 Diagnose (somente leitura) ==="

$RepoRoot = Resolve-Crypto10RepoRoot -ScriptRoot $PSScriptRoot
$identity = Test-Crypto10RepoIdentity -RepoRoot $RepoRoot
Write-Host "identidade_repositorio: $(if ($identity.IsValid) { 'ok' } else { 'INVALIDA' }) ($RepoRoot)"
if (-not $identity.IsValid) {
    Write-Host "  marcadores_ausentes: $($identity.MissingMarkers -join ', ')"
    Write-Host "  nome_pacote_ok: $($identity.PackageNameOk)"
}

$NodeExe = Find-Crypto10NodeExecutable
$NpmExe = Find-Crypto10NpmExecutable
Write-Host "node_encontrado: $(if ($NodeExe) { 'sim' } else { 'NAO' })"
Write-Host "npm_encontrado: $(if ($NpmExe) { 'sim' } else { 'NAO' })"
if ($NodeExe) {
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $NodeExe
        $psi.Arguments = "--version"
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.CreateNoWindow = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $ver = $p.StandardOutput.ReadToEnd().Trim()
        $p.WaitForExit(5000) | Out-Null
        Write-Host "node_versao: $ver"
    } catch {
        Write-Host "node_versao: (falha ao consultar)"
    }
}

$paths = Get-Crypto10RuntimePaths -RepoRoot $RepoRoot
Write-Host "banco_presente: $(Test-Path -LiteralPath $paths.MarketDbPath -PathType Leaf)"

# Porta -- tenta a porta real publicada no log (curto, nao bloqueante); se
# nao houver, informa a checagem contra a porta padrao documentada (4300,
# nao e segredo) apenas como referencia.
$port = Get-Crypto10DashboardPortFromLog -RepoRoot $RepoRoot -TimeoutSec 2 -PollIntervalMs 250
$portSource = "log do dashboard"
if (-not $port) {
    $port = 4300
    $portSource = "default documentado (dashboard pode nao ter publicado ainda)"
}
Write-Host "porta_verificada: $port (origem: $portSource)"

$occupant = Get-Crypto10PortOccupant -Port $port
if ($occupant.Occupied) {
    Write-Host "porta_estado: ocupada"
    Write-Host "porta_ocupada_por: PID $($occupant.ProcessId), processo '$($occupant.ProcessName)' (nunca encerrado por este diagnostico)"
} else {
    Write-Host "porta_estado: livre"
}

$lock = Get-Crypto10SupervisorLock -RepoRoot $RepoRoot
if ($lock) {
    Write-Host "lock_supervisor: presente (PID $($lock.ProcessId), startedAt $($lock.StartedAt))"
    if ($NodeExe) {
        $check = Test-Crypto10ManagedProcess -ProcessId $lock.ProcessId -ExpectedScriptPath $paths.SupervisorScript
        Write-Host "  Exists=$($check.Exists) IsNode=$($check.IsNode) MatchesScript=$($check.MatchesScript)"
    }
} else {
    Write-Host "lock_supervisor: ausente"
}

if (Test-Path -LiteralPath $paths.PidsDir -PathType Container) {
    # @(...) forca array mesmo com 0/1 resultado -- sem isso, .Count falha
    # sob Set-StrictMode quando a pasta esta vazia (Get-ChildItem devolve
    # $null, nao um array vazio).
    $pidFiles = @(Get-ChildItem -LiteralPath $paths.PidsDir -Filter "*.pid" -File -ErrorAction SilentlyContinue)
    Write-Host "pid_files: $($pidFiles.Count) encontrados em runtime\pids"
} else {
    Write-Host "pid_files: pasta runtime\pids ausente"
}

# Health -- uma unica tentativa, sem loop, sem retry longo (diagnostico e
# sobre AGORA, nao uma espera).
if ($NodeExe) {
    $health = Invoke-Crypto10HealthCheck -Port $port -NodeExe $NodeExe -RepoRoot $RepoRoot -TimeoutSec 3
    Write-Host "health_alcancado: $($health.Reached)"
    Write-Host "health_http_status: $(if ($health.StatusCode) { $health.StatusCode } else { 'sem resposta' })"
    Write-Host "health_pronto: $($health.Ready)"
    if ($health.Body) {
        Write-Host "  mode=$($health.Body.mode) tradingExecutionEnabled=$($health.Body.tradingExecutionEnabled) database=$($health.Body.database)"
    }
}

# Permissoes de leitura/escrita -- ESTRITAMENTE somente leitura: nunca cria,
# apaga, renomeia, toca timestamp ou escreve nada, nem uma sonda temporaria.
# Avalia so por ACL/metadados ja existentes (Get-Acl, nunca uma tentativa
# real de escrita). Se a ACL nao permitir concluir com confianca, devolve
# "not_verified_without_write" -- NUNCA finge certeza que nao tem.
function Get-Crypto10FolderWriteCapability {
    param([Parameter(Mandatory = $true)][string]$FolderPath)
    if (-not (Test-Path -LiteralPath $FolderPath -PathType Container)) {
        return "not_verified_without_write"
    }
    try {
        $acl = Get-Acl -LiteralPath $FolderPath -ErrorAction Stop
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $currentSid = $identity.User
        $groupSids = $identity.Groups
        $writeRights = [System.Security.AccessControl.FileSystemRights]::Write -bor `
            [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor `
            [System.Security.AccessControl.FileSystemRights]::Modify
        $allow = $false
        $deny = $false
        foreach ($ace in $acl.Access) {
            $aceSid = $null
            try { $aceSid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) } catch { continue }
            $appliesToMe = ($aceSid -eq $currentSid) -or ($groupSids -contains $aceSid)
            if (-not $appliesToMe) { continue }
            $grantsWrite = ([int]$ace.FileSystemRights -band [int]$writeRights) -ne 0
            if (-not $grantsWrite) { continue }
            if ($ace.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) { $deny = $true }
            if ($ace.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) { $allow = $true }
        }
        if ($deny) { return "denied_by_acl" }
        if ($allow) { return "likely_writable_by_acl" }
        return "not_verified_without_write"
    } catch {
        return "not_verified_without_write"
    }
}
Write-Host "permissao_runtime (writeCapability): $(Get-Crypto10FolderWriteCapability -FolderPath $paths.RuntimeDir)"
Write-Host "permissao_logs (writeCapability): $(Get-Crypto10FolderWriteCapability -FolderPath $paths.LogsDir)"
Write-Host "permissao_data_leitura: $(Test-Path -LiteralPath $paths.DataDir -PathType Container)"

# Variaveis -- SO nomes presentes/ausentes, nunca valores. Le o .env
# diretamente (nunca process.env de outro processo), extraindo somente a
# chave antes do primeiro '='.
$RelevantEnvNames = @(
    "BYBIT_API_KEY", "BYBIT_API_SECRET", "BYBIT_DEMO", "BYBIT_TESTNET",
    "DASHBOARD_PORT", "SUPERVISOR_PROFILE", "TRADING_EXECUTION_ENABLED",
    "FRED_API_KEY", "COINMARKETCAL_API_KEY",
    "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION",
    "AGENTROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"
)
$envPath = Join-Path $RepoRoot ".env"
$presentNames = New-Object System.Collections.Generic.HashSet[string]
if (Test-Path -LiteralPath $envPath -PathType Leaf) {
    $lines = Get-Content -LiteralPath $envPath -ErrorAction SilentlyContinue
    foreach ($line in $lines) {
        $m = [regex]::Match($line, '^([A-Za-z_][A-Za-z0-9_]*)=')
        if ($m.Success) { [void]$presentNames.Add($m.Groups[1].Value) }
    }
}
Write-Host "variaveis (.env) -- so presenca, nunca valor:"
foreach ($name in $RelevantEnvNames) {
    $state = "ausente"
    if ($presentNames.Contains($name)) { $state = "presente" }
    Write-Host "  $name : $state"
}

Write-Host "perfil_seguro_esperado: safe"
Write-Host "gate_financeiro_esperado: desligado (TRADING_EXECUTION_ENABLED=false)"

# Politica de execucao -- reportada, NUNCA contornada automaticamente.
try {
    $effective = Get-ExecutionPolicy
    Write-Host "politica_execucao_efetiva: $effective"
    if ($effective -eq "Restricted" -or $effective -eq "AllSigned") {
        Write-Host "  AVISO: esta politica pode IMPEDIR a execucao destes scripts. Reportado -- este diagnostico nao altera a politica."
    }
} catch {
    Write-Host "politica_execucao_efetiva: (falha ao consultar)"
}

# Sessao interativa -- Session 0 (servicos) nunca consegue abrir um
# navegador visivel pro usuario.
try {
    $sessionId = (Get-Process -Id $PID).SessionId
    $interactive = ($sessionId -ne 0)
    Write-Host "sessao_interativa: $interactive (SessionId=$sessionId)"
    if (-not $interactive) {
        Write-Host "  AVISO: sessao nao-interativa (Session 0) -- abrir navegador aqui nao mostraria nada a nenhum usuario."
    }
} catch {
    Write-Host "sessao_interativa: (falha ao consultar)"
}

Write-Host "=== Fim do diagnostico ==="
exit 0
