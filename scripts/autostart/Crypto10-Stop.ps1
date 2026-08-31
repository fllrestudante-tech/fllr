# Crypto10-Stop.ps1 -- encerra o supervisor (e, por consequencia, os
# filhos do perfil seguro) SOMENTE depois de validar que o PID do lock e
# de fato node.exe rodando scripts\supervisor.js deste repositorio. Nunca
# usa Stop-Process -Name node (mataria qualquer node.exe do sistema, de
# qualquer projeto). Recusa tocar num PID que nao valida.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)][int]$GracefulTimeoutSec = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "Crypto10-Common.ps1")

function Wait-Crypto10ProcessGone {
    param([Parameter(Mandatory = $true)][int]$ProcessId, [Parameter(Mandatory = $true)][int]$TimeoutSec)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $info = Get-Crypto10ProcessLookup -ProcessId $ProcessId
        if (-not $info) { return $true }
        Start-Sleep -Milliseconds 500
    }
    $info = Get-Crypto10ProcessLookup -ProcessId $ProcessId
    return (-not $info)
}

function Stop-Crypto10ValidatedProcess {
    <#
    .SYNOPSIS
    So chega aqui depois que o chamador ja confirmou Exists+IsNode+
    MatchesScript pro PID -- tenta encerramento gracioso (taskkill sem /F,
    nunca cmd /c: chamado direto via ProcessStartInfo) e escala pra
    Stop-Process -Force SOMENTE nesse mesmo PID ja validado se ainda
    estiver vivo apos o timeout.
    #>
    param([Parameter(Mandatory = $true)][int]$ProcessId, [Parameter(Mandatory = $true)][int]$TimeoutSec)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "taskkill.exe"
    $psi.Arguments = "/PID $ProcessId"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
        $p.WaitForExit(5000) | Out-Null
    } catch {
        # taskkill ausente/falhou ao iniciar -- segue pro polling/escalonamento mesmo assim
    }

    $gone = Wait-Crypto10ProcessGone -ProcessId $ProcessId -TimeoutSec $TimeoutSec
    if ($gone) {
        return "graceful"
    }

    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    } catch {
        return "failed"
    }
    $goneAfterForce = Wait-Crypto10ProcessGone -ProcessId $ProcessId -TimeoutSec 10
    if ($goneAfterForce) { return "forced" }
    return "failed"
}

$RepoRoot = Resolve-Crypto10RepoRoot -ScriptRoot $PSScriptRoot
$identity = Test-Crypto10RepoIdentity -RepoRoot $RepoRoot
if (-not $identity.IsValid) {
    Write-Host "BLOQUEADO: identidade do repositorio invalida em '$RepoRoot' -- nenhum processo foi tocado."
    exit 1
}

$paths = Get-Crypto10RuntimePaths -RepoRoot $RepoRoot
$stoppedComponents = New-Object System.Collections.Generic.List[string]
$exitCode = 0

$lock = Get-Crypto10SupervisorLock -RepoRoot $RepoRoot
if (-not $lock) {
    Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Nenhum lock de supervisor encontrado -- nada pra parar."
} else {
    $check = Test-Crypto10ManagedProcess -ProcessId $lock.ProcessId -ExpectedScriptPath $paths.SupervisorScript
    if (-not $check.Exists) {
        Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Lock aponta pro PID $($lock.ProcessId), que nao existe mais (obsoleto) -- removendo o lock, nenhum processo foi tocado."
        Remove-Item -LiteralPath $paths.LockFile -Force -ErrorAction SilentlyContinue
    } elseif (-not ($check.IsNode -and $check.MatchesScript)) {
        Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "RECUSADO: PID $($lock.ProcessId) existe mas NAO corresponde a node.exe rodando scripts\supervisor.js deste repositorio (IsNode=$($check.IsNode) MatchesScript=$($check.MatchesScript)) -- pode ter sido reaproveitado por outro processo. Nada foi tocado."
        $exitCode = 1
    } else {
        Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "PID $($lock.ProcessId) validado (node.exe, scripts\supervisor.js deste repositorio). Solicitando encerramento gracioso (timeout ${GracefulTimeoutSec}s)..."
        $result = Stop-Crypto10ValidatedProcess -ProcessId $lock.ProcessId -TimeoutSec $GracefulTimeoutSec
        if ($result -eq "graceful") {
            Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Supervisor (PID $($lock.ProcessId)) encerrado graciosamente."
            $stoppedComponents.Add("supervisor")
        } elseif ($result -eq "forced") {
            Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Supervisor (PID $($lock.ProcessId)) nao encerrou a tempo -- escalado para encerramento forcado SOMENTE deste PID ja validado."
            $stoppedComponents.Add("supervisor (forcado)")
        } else {
            Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "FALHA: nao foi possivel encerrar o PID $($lock.ProcessId) mesmo apos escalonamento."
            $exitCode = 1
        }
        if (Test-Path -LiteralPath $paths.LockFile -PathType Leaf) {
            Remove-Item -LiteralPath $paths.LockFile -Force -ErrorAction SilentlyContinue
        }
    }
}

# Limpeza de filhos orfaos -- so depois de o supervisor estar confirmado
# fora do ar (caminho forcado pode ter pulado o shutdown() dele, que e
# quem normalmente encerra os filhos). Cada PID em runtime\pids\*.pid e
# validado INDIVIDUALMENTE contra a lista canonica (lib/supervisorProfile.js
# via childrenSummaryCli.js, campo `all` -- que ja inclui "bot" com seu
# `script` = index.js, mesma fonte unica de sempre) antes de qualquer acao.
# "bot" NAO e mais ignorado por nome (era assim quando este wrapper so
# sabia operar o perfil "safe", que nunca inclui o bot) -- agora passa pela
# MESMA validacao Exists+IsNode+MatchesScript de qualquer outro filho, nunca
# um caminho especial, nunca `Stop-Process -Name`/taskkill amplo. Um PID
# que existe mas NAO bate (reaproveitado por outro processo, ou node.exe
# rodando outra coisa) e LOGADO e IGNORADO -- fail-closed, nunca encerrado
# "pra garantir".
if (Test-Path -LiteralPath $paths.PidsDir -PathType Container) {
    $NodeExe = Find-Crypto10NodeExecutable
    $summary = $null
    if ($NodeExe) { $summary = Get-Crypto10SafeChildrenSummary -NodeExe $NodeExe -RepoRoot $RepoRoot }

    $pidFiles = Get-ChildItem -LiteralPath $paths.PidsDir -Filter "*.pid" -File -ErrorAction SilentlyContinue
    foreach ($pidFile in $pidFiles) {
        $childName = [System.IO.Path]::GetFileNameWithoutExtension($pidFile.Name)
        $childScript = $null
        if ($summary) {
            $match = $summary.all | Where-Object { $_.name -eq $childName }
            if ($match) { $childScript = $match.script }
        }
        if (-not $childScript) { continue }

        $childPidRaw = (Get-Content -LiteralPath $pidFile.FullName -Raw -ErrorAction SilentlyContinue)
        $childPid = 0
        if (-not [int]::TryParse(($childPidRaw -as [string]).Trim(), [ref]$childPid)) { continue }

        $childCheck = Test-Crypto10ManagedProcess -ProcessId $childPid -ExpectedScriptPath $childScript
        if ($childCheck.Exists -and $childCheck.IsNode -and $childCheck.MatchesScript) {
            Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Filho orfao validado: $childName (PID $childPid) -- encerrando."
            $childResult = Stop-Crypto10ValidatedProcess -ProcessId $childPid -TimeoutSec 10
            if ($childResult -ne "failed") {
                $stoppedComponents.Add($childName)
                Remove-Item -LiteralPath $pidFile.FullName -Force -ErrorAction SilentlyContinue
            }
        } elseif (-not $childCheck.Exists) {
            Remove-Item -LiteralPath $pidFile.FullName -Force -ErrorAction SilentlyContinue
        } else {
            Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "RECUSADO: $childName (PID $childPid) existe mas NAO corresponde a node.exe rodando '$childScript' (IsNode=$($childCheck.IsNode) MatchesScript=$($childCheck.MatchesScript)) -- pode ter sido reaproveitado por outro processo. Nada foi tocado, arquivo PID mantido pra investigacao."
        }
    }
}

if ($stoppedComponents.Count -gt 0) {
    Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Componentes encerrados: $($stoppedComponents -join ', ')."
} else {
    Write-Crypto10AutostartLog -RepoRoot $RepoRoot -Message "Nenhum componente foi encerrado nesta execucao."
}

exit $exitCode
