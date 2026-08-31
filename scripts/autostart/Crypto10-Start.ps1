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
    [Parameter(Mandatory = $false)][switch]$NoBrowser,
    # Ausente -> "safe" (comportamento IDENTICO a antes desta rodada -- a
    # tarefa agendada real, que chama este script sem parametros, continua
    # subindo "safe" sem nenhuma mudanca). "demo" precisa ser selecao
    # EXPLICITA (nunca inferida) e exige -DemoExecutionMode junto.
    [Parameter(Mandatory = $false)][ValidateSet("safe", "demo")][string]$SupervisorProfile = "safe",
    # Só relevante com -SupervisorProfile demo. "execution" ainda nao e
    # aceito por este wrapper (reservado pra ativacao futura, mesmo
    # contrato de lib/demoExecutionMode.js) -- só "observe" e um valor
    # valido aqui hoje.
    [Parameter(Mandatory = $false)][ValidateSet("observe")][string]$DemoExecutionMode,
    # Só relevante com -SupervisorProfile demo. ValidateSet("SOLUSDT") --
    # nesta rodada so o literal exato e aceito (PowerShell rejeita QUALQUER
    # outro valor antes do corpo do script sequer rodar). Injetado
    # EXPLICITAMENTE no ambiente do supervisor/filhos (bloco de spawn
    # abaixo) -- nunca herdado do SYMBOL do .env, que e o que dotenv faria
    # por conta propria se este parametro nao existisse.
    [Parameter(Mandatory = $false)][ValidateSet("SOLUSDT")][string]$Symbol
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

# 0. Selecao explicita do perfil/modo -- ausente = "safe" (default seguro,
# identico ao comportamento de sempre). "demo" SEM -DemoExecutionMode e
# rejeitado imediatamente, antes de qualquer log/identidade/spawn --
# nunca assume "observe" por omissao (mesmo espirito fail-closed de
# lib/demoExecutionMode.js::resolveDemoExecutionMode).
if ($SupervisorProfile -eq "demo" -and [string]::IsNullOrEmpty($DemoExecutionMode)) {
    Write-Host "BLOQUEADO: -SupervisorProfile demo exige -DemoExecutionMode explicito (hoje só 'observe' e aceito). Nada foi iniciado."
    exit 1
}
# -Symbol obrigatorio no perfil demo -- mesma logica fail-closed acima,
# checada ANTES de qualquer log/identidade/spawn. "SOLUSDT" e o unico valor
# que o ValidateSet do parametro aceita (uma tentativa de -Symbol BTCUSDT,
# por exemplo, ja teria sido rejeitada pelo PowerShell antes deste ponto).
if ($SupervisorProfile -eq "demo" -and [string]::IsNullOrEmpty($Symbol)) {
    Write-Host "BLOQUEADO: -SupervisorProfile demo exige -Symbol explicito (hoje só 'SOLUSDT' e aceito). Nada foi iniciado."
    exit 1
}

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
        # SUPERVISOR_PROFILE/DEMO_EXECUTION_MODE/TRADING_EXECUTION_ENABLED
        # sobrescritos no AMBIENTE DESTE PROCESSO antes do spawn -- o
        # filho herda exatamente esses valores, nunca os do usuario.
        # TRADING_EXECUTION_ENABLED e SEMPRE "false" aqui, incondicionalmente
        # -- nenhum parametro deste script consegue mudar isso (nunca
        # habilitar execucao financeira automaticamente no login, mesmo
        # pedindo -SupervisorProfile demo -DemoExecutionMode observe).
        # Os valores ORIGINAIS (mesmo se ausentes) sao salvos e restaurados
        # logo apos o spawn -- o filho ja herdou sua propria copia do
        # ambiente no momento da criacao (Start-Process/CreateProcess),
        # entao restaurar o ambiente DESTE processo depois nao o afeta, e
        # nenhuma variavel perigosa vaza pra comandos posteriores desta
        # mesma sessao PowerShell (ex.: se este script for dot-sourced em
        # vez de invocado standalone).
        $previousSupervisorProfile = $env:SUPERVISOR_PROFILE
        $previousDemoExecutionMode = $env:DEMO_EXECUTION_MODE
        $previousSymbol = $env:SYMBOL
        $previousDemoPrivateReadEnabled = $env:DEMO_PRIVATE_READ_ENABLED
        $previousTradingExecutionEnabled = $env:TRADING_EXECUTION_ENABLED
        $env:SUPERVISOR_PROFILE = $SupervisorProfile
        if ($SupervisorProfile -eq "demo") {
            $env:DEMO_EXECUTION_MODE = $DemoExecutionMode
            # Injetado explicitamente -- NUNCA deixa o processo Node herdar
            # SYMBOL do .env (que hoje tem um valor diferente de SOLUSDT).
            # dotenv (config.js) so preenche variaveis AUSENTES do
            # process.env -- com isto ja setado aqui, o SYMBOL do .env e
            # ignorado pelo filho, exatamente a garantia exigida.
            $env:SYMBOL = $Symbol
            # DEMO_PRIVATE_READ_ENABLED="true" -- SOMENTE aqui, dentro do
            # ramo demo, e SOMENTE porque -DemoExecutionMode ja foi
            # validado como exatamente "observe" (ValidateSet, checagem no
            # topo do arquivo) e -Symbol ja foi validado como exatamente
            # "SOLUSDT" (idem) ANTES deste ponto -- nenhum dos tres nunca
            # chega aqui com valor diferente. Habilita SOMENTE leitura
            # privada demo (lib/demoOrderGate.js::assertDemoPrivateReadAllowed);
            # NUNCA autoriza mutacao por si so -- isso continua exigindo
            # TRADING_EXECUTION_ENABLED=true (linha abaixo, sempre "false"
            # aqui) E o gate canonico de ordem. Sem isto, o dashboard nunca
            # reporta privateReadReady=true e a leitura de snapshot do bot
            # nunca teria como funcionar mesmo com o clock preflight ok
            # (achado real desta auditoria).
            $env:DEMO_PRIVATE_READ_ENABLED = "true"
        } else {
            Remove-Item Env:\DEMO_EXECUTION_MODE -ErrorAction SilentlyContinue
            Remove-Item Env:\DEMO_PRIVATE_READ_ENABLED -ErrorAction SilentlyContinue
            # Perfil safe nunca roda o "bot" (unico consumidor de SYMBOL) --
            # nao toca em $env:SYMBOL de proposito aqui, pra preservar
            # EXATAMENTE o comportamento de antes desta rodada. Perfil
            # safe tambem NUNCA recebe leitura privada demo -- removido
            # explicitamente, nunca herdado do .env (que tambem nao o
            # define hoje, mas a remocao aqui e a garantia real, nao a
            # ausencia no .env).
        }
        $env:TRADING_EXECUTION_ENABLED = "false"

        # UTC explicito -- MESMA convencao de lib/logRotation.js (ver
        # comentario daquele arquivo). Precisa bater com a pasta que
        # scripts/supervisor.js/seus filhos escrevem via Node, senao os logs
        # do wrapper (out/err) e os logs por-componente do dia ficam em
        # pastas diferentes.
        $today = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
        $logDir = Join-Path $paths.LogsDir $today
        if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
        # Nomeado "supervisor.out/err.<timestamp>.log" (nao "supervisor.log"
        # nem um nome fixo) pra nunca colidir com o log por-componente que
        # scripts/supervisor.js ja escreve pros FILHOS dele (lib/
        # logRotation.js), E pra nunca sobrescrever silenciosamente o log
        # da execucao ANTERIOR -- Start-Process -RedirectStandardOutput/
        # -Error RECRIA (trunca) o arquivo a cada lancamento; um nome fixo
        # apagaria a evidencia de uma falha assim que o wrapper rodasse de
        # novo (achado real desta auditoria). Retencao limitada embutida
        # em Get-Crypto10SupervisorRunLogPaths -- nunca cresce sem limite.
        $logPaths = Get-Crypto10SupervisorRunLogPaths -LogDir $logDir
        $outLog = $logPaths.OutLog
        $errLog = $logPaths.ErrLog

        # Log so cita o SIMBOLO -- nunca credenciais/chaves, mesma
        # disciplina de todo log deste projeto.
        $profileLabel = if ($SupervisorProfile -eq "demo") { "demo, modo $DemoExecutionMode, symbol $Symbol" } else { "safe" }
        Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Iniciando scripts\supervisor.js (perfil $profileLabel, gate financeiro desligado) -- stdout/stderr em '$outLog' / '$errLog'."
        try {
            $started = Start-Process -FilePath $NodeExe -ArgumentList @("`"$($paths.SupervisorScript)`"") -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
            Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Supervisor iniciado (PID $($started.Id)). Independente deste wrapper -- continua rodando mesmo depois que este script terminar."
        } finally {
            # Restaura SEMPRE, mesmo se o spawn falhar -- nunca deixa o
            # ambiente deste processo com os valores forcados.
            if ($null -eq $previousSupervisorProfile) { Remove-Item Env:\SUPERVISOR_PROFILE -ErrorAction SilentlyContinue } else { $env:SUPERVISOR_PROFILE = $previousSupervisorProfile }
            if ($null -eq $previousDemoExecutionMode) { Remove-Item Env:\DEMO_EXECUTION_MODE -ErrorAction SilentlyContinue } else { $env:DEMO_EXECUTION_MODE = $previousDemoExecutionMode }
            if ($null -eq $previousSymbol) { Remove-Item Env:\SYMBOL -ErrorAction SilentlyContinue } else { $env:SYMBOL = $previousSymbol }
            if ($null -eq $previousDemoPrivateReadEnabled) { Remove-Item Env:\DEMO_PRIVATE_READ_ENABLED -ErrorAction SilentlyContinue } else { $env:DEMO_PRIVATE_READ_ENABLED = $previousDemoPrivateReadEnabled }
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

    $expectedHealthMode = if ($SupervisorProfile -eq "demo") { "demo_observe" } else { "safe" }
    $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
    $delayMs = 500
    $maxDelayMs = 5000
    $ready = $false
    $lastStatusCode = $null
    $lastReached = $false
    while ((Get-Date) -lt $deadline) {
        $health = Invoke-Crypto10HealthCheck -Port $port -NodeExe $NodeExe -RepoRoot $RepoRoot -TimeoutSec 3 -ExpectedMode $expectedHealthMode
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
    Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Health pronto (200, expectedMode=$expectedHealthMode, tradingExecutionEnabled=false, database=ok)."

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
