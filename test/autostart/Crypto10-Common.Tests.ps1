# Crypto10-Common.Tests.ps1 -- testes da logica pura/injetavel de
# scripts/autostart/Crypto10-Common.ps1, sem Pester. Roda com:
#   powershell -NoProfile -File test\autostart\Crypto10-Common.Tests.ps1
# Todo processo real usado (HttpListener/TcpListener/arquivos temporarios)
# e fixture controlada, encerrada/removida no final de cada bloco.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Path (Split-Path -Path $PSScriptRoot -Parent) -Parent
$AutostartDir = Join-Path $RepoRoot "scripts\autostart"

. (Join-Path $PSScriptRoot "TestHarness.ps1")
. (Join-Path $AutostartDir "Crypto10-Common.ps1")

Write-Host "=== Crypto10-Common.Tests.ps1 ==="

$NodeExeForTests = Find-Crypto10NodeExecutable
if (-not $NodeExeForTests) {
    Write-Host "AVISO: node.exe nao encontrado no PATH -- testes que dependem dele vao falhar de forma clara."
}

# ---------------------------------------------------------------------
# Sintaxe -- os 5 scripts precisam parsear sem erro (compatibilidade com
# o Windows PowerShell da maquina, checado a cada rodada).
# ---------------------------------------------------------------------
foreach ($scriptName in @("Crypto10-Common.ps1", "Crypto10-Start.ps1", "Crypto10-Stop.ps1", "Crypto10-Status.ps1", "Crypto10-Diagnose.ps1")) {
    Test-Case "sintaxe: $scriptName parseia sem erro" {
        $path = Join-Path $AutostartDir $scriptName
        $parseErrors = $null
        $tokens = $null
        [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$parseErrors) | Out-Null
        Assert-Equal -Expected 0 -Actual $parseErrors.Count -Message "$scriptName tem erro(s) de sintaxe"
    }
}

# ---------------------------------------------------------------------
# Resolucao de caminho / identidade do repositorio
# ---------------------------------------------------------------------
Test-Case "Resolve-Crypto10RepoRoot: resolve o repo real a partir do caminho do script" {
    $resolved = Resolve-Crypto10RepoRoot -ScriptRoot $AutostartDir
    Assert-Equal -Expected $RepoRoot -Actual $resolved
}

Test-Case "Test-Crypto10RepoIdentity: repositorio real -> valido" {
    $identity = Test-Crypto10RepoIdentity -RepoRoot $RepoRoot
    Assert-True $identity.IsValid
    Assert-Equal -Expected 0 -Actual $identity.MissingMarkers.Count
}

Test-Case "Test-Crypto10RepoIdentity: diretorio sem nenhum marcador -> invalido, lista os ausentes" {
    $fakeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("crypto10-test-empty-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $fakeDir -Force | Out-Null
    try {
        $identity = Test-Crypto10RepoIdentity -RepoRoot $fakeDir
        Assert-False $identity.IsValid
        Assert-True ($identity.MissingMarkers.Count -gt 0)
    } finally {
        Remove-Item -LiteralPath $fakeDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Test-Case "Test-Crypto10RepoIdentity: package.json com nome errado -> invalido" {
    $fakeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("crypto10-test-wrongpkg-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $fakeDir -Force | Out-Null
    try {
        Set-Content -LiteralPath (Join-Path $fakeDir "package.json") -Value '{"name":"outro-projeto-qualquer"}'
        $identity = Test-Crypto10RepoIdentity -RepoRoot $fakeDir
        Assert-False $identity.IsValid
        Assert-False $identity.PackageNameOk
    } finally {
        Remove-Item -LiteralPath $fakeDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------
# Validacao de processo -- PID obsoleto / reutilizado / valido, tudo via
# -Lookup injetado (fixture pura, nenhum processo real necessario).
# ---------------------------------------------------------------------
Test-Case "Test-Crypto10ManagedProcess: PID obsoleto (lookup nao encontra nada) -> Exists=False" {
    $fakeLookup = { param($ProcessId) return $null }
    $result = Test-Crypto10ManagedProcess -ProcessId 999999 -ExpectedScriptPath "C:\qualquer\scripts\supervisor.js" -Lookup $fakeLookup
    Assert-False $result.Exists
    Assert-False $result.MatchesScript
}

Test-Case "Test-Crypto10ManagedProcess: PID reutilizado por processo que NAO e node.exe -> IsNode=False, MatchesScript=False" {
    $fakeLookup = { param($ProcessId) return [PSCustomObject]@{ ProcessId = $ProcessId; Name = "chrome.exe"; CommandLine = "chrome.exe --profile-directory=Default" } }
    $result = Test-Crypto10ManagedProcess -ProcessId 4242 -ExpectedScriptPath "C:\bot-cripto10\scripts\supervisor.js" -Lookup $fakeLookup
    Assert-True $result.Exists
    Assert-False $result.IsNode
    Assert-False $result.MatchesScript
}

Test-Case "Test-Crypto10ManagedProcess: node.exe rodando OUTRO script (nao supervisor.js) -> MatchesScript=False" {
    $fakeLookup = { param($ProcessId) return [PSCustomObject]@{ ProcessId = $ProcessId; Name = "node.exe"; CommandLine = 'node.exe "C:\bot-cripto10\scripts\metricsSampler.js"' } }
    $result = Test-Crypto10ManagedProcess -ProcessId 4242 -ExpectedScriptPath "C:\bot-cripto10\scripts\supervisor.js" -Lookup $fakeLookup
    Assert-True $result.IsNode
    Assert-False $result.MatchesScript
}

Test-Case "Test-Crypto10ManagedProcess: node.exe rodando supervisor.js DESTE repositorio -> Exists/IsNode/MatchesScript=True" {
    $fakeLookup = { param($ProcessId) return [PSCustomObject]@{ ProcessId = $ProcessId; Name = "node.exe"; CommandLine = 'node.exe "C:\bot-cripto10\scripts\supervisor.js"' } }
    $result = Test-Crypto10ManagedProcess -ProcessId 4242 -ExpectedScriptPath "C:\bot-cripto10\scripts\supervisor.js" -Lookup $fakeLookup
    Assert-True $result.Exists
    Assert-True $result.IsNode
    Assert-True $result.MatchesScript
}

Test-Case "Test-Crypto10ManagedProcess: comparacao de caminho e case-insensitive (Windows)" {
    $fakeLookup = { param($ProcessId) return [PSCustomObject]@{ ProcessId = $ProcessId; Name = "NODE.EXE"; CommandLine = 'node.exe "C:\BOT-CRIPTO10\SCRIPTS\SUPERVISOR.JS"' } }
    $result = Test-Crypto10ManagedProcess -ProcessId 4242 -ExpectedScriptPath "C:\bot-cripto10\scripts\supervisor.js" -Lookup $fakeLookup
    Assert-True $result.MatchesScript
}

Test-Case "Get-Crypto10ProcessLookup (real, sem fake): PID inexistente devolve `$null" {
    $info = Get-Crypto10ProcessLookup -ProcessId 999999
    Assert-Null $info
}

# ---------------------------------------------------------------------
# Lock do supervisor
# ---------------------------------------------------------------------
Test-Case "Get-Crypto10SupervisorLock: arquivo ausente -> `$null" {
    $fakeRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("crypto10-test-nolock-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $fakeRepo -Force | Out-Null
    try {
        $lock = Get-Crypto10SupervisorLock -RepoRoot $fakeRepo
        Assert-Null $lock
    } finally {
        Remove-Item -LiteralPath $fakeRepo -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Test-Case "Get-Crypto10SupervisorLock: le pid/startedAt de um lock valido" {
    $fakeRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("crypto10-test-lock-" + [Guid]::NewGuid().ToString("N"))
    $lockDir = Join-Path $fakeRepo "runtime\locks"
    New-Item -ItemType Directory -Path $lockDir -Force | Out-Null
    try {
        @{ pid = 1234; startedAt = "2026-01-01T00:00:00.000Z" } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $lockDir "supervisor.lock")
        $lock = Get-Crypto10SupervisorLock -RepoRoot $fakeRepo
        Assert-NotNull $lock
        Assert-Equal -Expected 1234 -Actual $lock.ProcessId
        Assert-Equal -Expected "2026-01-01T00:00:00.000Z" -Actual $lock.StartedAt
    } finally {
        Remove-Item -LiteralPath $fakeRepo -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Test-Case "Get-Crypto10SupervisorLock: JSON corrompido -> `$null, nunca lanca" {
    $fakeRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("crypto10-test-badlock-" + [Guid]::NewGuid().ToString("N"))
    $lockDir = Join-Path $fakeRepo "runtime\locks"
    New-Item -ItemType Directory -Path $lockDir -Force | Out-Null
    try {
        Set-Content -LiteralPath (Join-Path $lockDir "supervisor.lock") -Value "isto nao e json {{{"
        $lock = Get-Crypto10SupervisorLock -RepoRoot $fakeRepo
        Assert-Null $lock
    } finally {
        Remove-Item -LiteralPath $fakeRepo -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------
# Marcador de navegador ja aberto
# ---------------------------------------------------------------------
Test-Case "Browser marker: ausente -> Test-Crypto10BrowserAlreadyOpened=False; depois de marcar, True pro MESMO pid+startedAt" {
    $fakeRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("crypto10-test-browser-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $fakeRepo -Force | Out-Null
    try {
        $before = Test-Crypto10BrowserAlreadyOpened -RepoRoot $fakeRepo -SupervisorProcessId 111 -StartedAt "2026-01-01T00:00:00.000Z"
        Assert-False $before
        Set-Crypto10BrowserOpenedMarker -RepoRoot $fakeRepo -SupervisorProcessId 111 -StartedAt "2026-01-01T00:00:00.000Z"
        $after = Test-Crypto10BrowserAlreadyOpened -RepoRoot $fakeRepo -SupervisorProcessId 111 -StartedAt "2026-01-01T00:00:00.000Z"
        Assert-True $after
        $differentInstance = Test-Crypto10BrowserAlreadyOpened -RepoRoot $fakeRepo -SupervisorProcessId 222 -StartedAt "2026-01-01T00:00:00.000Z"
        Assert-False $differentInstance
    } finally {
        Remove-Item -LiteralPath $fakeRepo -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------
# Health check via HttpListener real, rodando num Start-Job (PROCESSO
# separado -- evita o problema conhecido de scriptblocks do PowerShell
# usados como callback .NET/Task no MESMO runspace, que nao tem acesso
# confiavel as funcoes do script chamador). Fixture controlada, sempre
# limpa no finally -- cobre health valido/503/JSON invalido/timeout/porta
# livre.
# ---------------------------------------------------------------------
function Start-Crypto10FakeHealthResponder {
    param([Parameter(Mandatory = $true)][int]$StatusCode, [Parameter(Mandatory = $true)][string]$Body)
    $port = Get-Random -Minimum 20000 -Maximum 40000
    $job = Start-Job -ScriptBlock {
        param($Port, $StatusCode, $Body)
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add("http://127.0.0.1:$Port/")
        $listener.Start()
        $ctx = $listener.GetContext()
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
        $ctx.Response.StatusCode = $StatusCode
        $ctx.Response.ContentType = "application/json"
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $ctx.Response.OutputStream.Close()
        $listener.Stop()
        $listener.Close()
    } -ArgumentList $port, $StatusCode, $Body
    Start-Sleep -Milliseconds 700
    return [PSCustomObject]@{ Job = $job; Port = $port }
}

function Stop-Crypto10FakeHealthResponder {
    param([Parameter(Mandatory = $true)]$Responder)
    Wait-Job -Job $Responder.Job -Timeout 5 | Out-Null
    Receive-Job -Job $Responder.Job -ErrorAction SilentlyContinue | Out-Null
    Remove-Job -Job $Responder.Job -Force -ErrorAction SilentlyContinue
}

$ReadyBodyJson = '{"status":"ok","service":"crypto10-dashboard","mode":"safe","tradingExecutionEnabled":false,"database":"ok"}'
$DegradedBodyJson = '{"status":"degraded","service":"crypto10-dashboard","mode":"safe","tradingExecutionEnabled":true,"database":"ok"}'

Test-Case "Invoke-Crypto10HealthCheck: 200 com corpo pronto -> Ready=True" {
    $responder = Start-Crypto10FakeHealthResponder -StatusCode 200 -Body $ReadyBodyJson
    try {
        $health = Invoke-Crypto10HealthCheck -Port $responder.Port -NodeExe $NodeExeForTests -RepoRoot $RepoRoot -TimeoutSec 8
        Assert-True $health.Reached
        Assert-Equal -Expected 200 -Actual $health.StatusCode
        Assert-True $health.Ready
    } finally {
        Stop-Crypto10FakeHealthResponder -Responder $responder
    }
}

Test-Case "Invoke-Crypto10HealthCheck: 503 (degraded) -> Reached=True, Ready=False" {
    $responder = Start-Crypto10FakeHealthResponder -StatusCode 503 -Body $DegradedBodyJson
    try {
        $health = Invoke-Crypto10HealthCheck -Port $responder.Port -NodeExe $NodeExeForTests -RepoRoot $RepoRoot -TimeoutSec 8
        Assert-True $health.Reached
        Assert-Equal -Expected 503 -Actual $health.StatusCode
        Assert-False $health.Ready
    } finally {
        Stop-Crypto10FakeHealthResponder -Responder $responder
    }
}

Test-Case "Invoke-Crypto10HealthCheck: corpo NAO e JSON valido -> Reached=True, Ready=False, nunca lanca" {
    $responder = Start-Crypto10FakeHealthResponder -StatusCode 200 -Body "isto nao e json {{{"
    try {
        $health = Invoke-Crypto10HealthCheck -Port $responder.Port -NodeExe $NodeExeForTests -RepoRoot $RepoRoot -TimeoutSec 8
        Assert-True $health.Reached
        Assert-False $health.Ready
    } finally {
        Stop-Crypto10FakeHealthResponder -Responder $responder
    }
}

Test-Case "Invoke-Crypto10HealthCheck: porta livre/ninguem escutando -> Reached=False, Ready=False (timeout curto)" {
    $freePort = Get-Random -Minimum 40001 -Maximum 45000
    $health = Invoke-Crypto10HealthCheck -Port $freePort -NodeExe $NodeExeForTests -RepoRoot $RepoRoot -TimeoutSec 2
    Assert-False $health.Reached
    Assert-False $health.Ready
    Assert-Null $health.StatusCode
}

# ---------------------------------------------------------------------
# Ocupante de porta -- via -ConnectionLookup/-Lookup injetados (fixture
# pura, nenhuma conexao TCP real necessaria).
# ---------------------------------------------------------------------
Test-Case "Get-Crypto10PortOccupant: porta livre (lookup nao encontra conexao) -> Occupied=False" {
    $connLookup = { param($Port) return $null }
    $result = Get-Crypto10PortOccupant -Port 12345 -ConnectionLookup $connLookup
    Assert-False $result.Occupied
}

Test-Case "Get-Crypto10PortOccupant: porta ocupada -> identifica PID/nome do processo, nunca o encerra" {
    $connLookup = { param($Port) return [PSCustomObject]@{ OwningProcess = 4242 } }
    $procLookup = { param($ProcessId) return [PSCustomObject]@{ ProcessId = $ProcessId; Name = "node.exe"; CommandLine = "node.exe algumacoisa.js" } }
    $result = Get-Crypto10PortOccupant -Port 12345 -ConnectionLookup $connLookup -Lookup $procLookup
    Assert-True $result.Occupied
    Assert-Equal -Expected 4242 -Actual $result.ProcessId
    Assert-Equal -Expected "node.exe" -Actual $result.ProcessName
}

# ---------------------------------------------------------------------
# Invoke-Crypto10NodeScript / Get-Crypto10SafeChildrenSummary -- prova de
# que "bot" nunca aparece nos filhos seguros, via o CLI real (nao fake).
# ---------------------------------------------------------------------
Test-Case "Get-Crypto10SafeChildrenSummary: nunca inclui 'bot', inclui os 6 componentes seguros" {
    $summary = Get-Crypto10SafeChildrenSummary -NodeExe $NodeExeForTests -RepoRoot $RepoRoot
    Assert-NotNull $summary
    $names = $summary.safe.children | ForEach-Object { $_.name }
    Assert-False ($names -contains "bot")
    Assert-True (($names | Measure-Object).Count -ge 6)
}

# ---------------------------------------------------------------------
# Varredura de codigo-fonte -- provas estaticas exigidas explicitamente.
# ---------------------------------------------------------------------
$AllScriptFiles = @("Crypto10-Common.ps1", "Crypto10-Start.ps1", "Crypto10-Stop.ps1", "Crypto10-Status.ps1", "Crypto10-Diagnose.ps1") | ForEach-Object { Join-Path $AutostartDir $_ }

# Remove comentarios de linha (# ate o fim da linha) antes de escanear --
# sem isso, os proprios comentarios explicativos deste arquivo (ex.: "nunca
# usa Stop-Process -Name", "nunca usa -ExecutionPolicy Bypass") disparariam
# falso positivo por CITAREM o termo proibido como documentacao. Mesmo
# padrao ja usado nos meta-testes JS do projeto (remover comentario antes
# de procurar termo proibido no CODIGO de verdade).
function Get-Crypto10SourceWithoutComments {
    param([Parameter(Mandatory = $true)][string]$Path)
    $raw = Get-Content -LiteralPath $Path -Raw
    # Remove blocos <# ... #> PRIMEIRO (podem conter "#" em qualquer
    # posicao dentro, inclusive nenhuma por linha -- um strip so por linha
    # nao pega essas linhas de jeito nenhum).
    $noBlockComments = [regex]::Replace($raw, "(?s)<#.*?#>", "")
    $lines = $noBlockComments -split "`r?`n"
    $stripped = $lines | ForEach-Object {
        $idx = $_.IndexOf("#")
        if ($idx -ge 0) { $_.Substring(0, $idx) } else { $_ }
    }
    return ($stripped -join "`n")
}

Test-Case "varredura: nenhum arquivo referencia 'index.js' (o bot nunca e citado, nem pra excluir)" {
    foreach ($f in $AllScriptFiles) {
        $content = Get-Crypto10SourceWithoutComments -Path $f
        Assert-False ($content -match "index\.js") "$f menciona index.js"
    }
}

Test-Case "varredura: nenhum arquivo define TRADING_EXECUTION_ENABLED='true' (so 'false' e aceitavel)" {
    foreach ($f in $AllScriptFiles) {
        $content = Get-Crypto10SourceWithoutComments -Path $f
        Assert-False ($content -match 'TRADING_EXECUTION_ENABLED\s*=\s*"true"') "$f define TRADING_EXECUTION_ENABLED=true"
    }
}

Test-Case "varredura: Crypto10-Start.ps1 forca SUPERVISOR_PROFILE=safe e TRADING_EXECUTION_ENABLED=false" {
    $content = Get-Crypto10SourceWithoutComments -Path (Join-Path $AutostartDir "Crypto10-Start.ps1")
    Assert-True ($content -match '\$env:SUPERVISOR_PROFILE\s*=\s*"safe"')
    Assert-True ($content -match '\$env:TRADING_EXECUTION_ENABLED\s*=\s*"false"')
}

Test-Case "varredura: Crypto10-Start.ps1 salva os valores originais de SUPERVISOR_PROFILE/TRADING_EXECUTION_ENABLED ANTES de sobrescrever e os restaura num 'finally' apos o spawn (nao executa o script real -- so confirma a estrutura de save/restore no codigo)" {
    $content = Get-Crypto10SourceWithoutComments -Path (Join-Path $AutostartDir "Crypto10-Start.ps1")
    Assert-True ($content -match '\$previousSupervisorProfile\s*=\s*\$env:SUPERVISOR_PROFILE') "nao salva o valor original de SUPERVISOR_PROFILE antes de sobrescrever"
    Assert-True ($content -match '\$previousTradingExecutionEnabled\s*=\s*\$env:TRADING_EXECUTION_ENABLED') "nao salva o valor original de TRADING_EXECUTION_ENABLED antes de sobrescrever"
    Assert-True ($content -match 'finally\s*\{[\s\S]*?previousSupervisorProfile[\s\S]*?\}') "nao restaura SUPERVISOR_PROFILE num bloco finally"
    Assert-True ($content -match 'finally\s*\{[\s\S]*?previousTradingExecutionEnabled[\s\S]*?\}') "nao restaura TRADING_EXECUTION_ENABLED num bloco finally"
}

Test-Case "varredura: nenhum arquivo usa -ExecutionPolicy Bypass, Invoke-Expression, 'cmd /c', ou baixa ferramentas" {
    foreach ($f in $AllScriptFiles) {
        $content = Get-Crypto10SourceWithoutComments -Path $f
        Assert-False ($content -match "ExecutionPolicy\s+Bypass") "$f usa -ExecutionPolicy Bypass"
        Assert-False ($content -match "Invoke-Expression") "$f usa Invoke-Expression"
        Assert-False ($content -match "cmd\s*/c") "$f usa cmd /c"
        Assert-False ($content -match "Invoke-WebRequest.*\.exe|Start-BitsTransfer|DownloadFile") "$f parece baixar algo"
    }
}

Test-Case "varredura: Crypto10-Stop.ps1 nunca CHAMA Stop-Process -Name (nome generico) no codigo real" {
    $content = Get-Crypto10SourceWithoutComments -Path (Join-Path $AutostartDir "Crypto10-Stop.ps1")
    Assert-False ($content -match "Stop-Process\s+-Name")
}

Test-Case "varredura: Diagnose.ps1 nunca CHAMA Stop-Process/taskkill em processo no codigo real (somente leitura)" {
    $content = Get-Crypto10SourceWithoutComments -Path (Join-Path $AutostartDir "Crypto10-Diagnose.ps1")
    Assert-False ($content -match "Stop-Process")
    Assert-False ($content -match "taskkill")
}

Test-Case "varredura: Diagnose.ps1 nao contem NENHUM padrao de escrita/exclusao/renomeacao no codigo real -- estritamente somente leitura" {
    $content = Get-Crypto10SourceWithoutComments -Path (Join-Path $AutostartDir "Crypto10-Diagnose.ps1")
    $forbiddenPatterns = @(
        "New-Item", "Set-Content", "Add-Content", "Out-File",
        "Remove-Item", "Move-Item", "Copy-Item",
        "\.Create\(", "WriteAllText", "OpenWrite"
    )
    foreach ($pattern in $forbiddenPatterns) {
        Assert-False ($content -match $pattern) "Diagnose.ps1 contem o padrao de escrita '$pattern'"
    }
}

Complete-Crypto10Tests
