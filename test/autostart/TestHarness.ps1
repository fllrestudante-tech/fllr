# TestHarness.ps1 -- runner minimo pra testes de scripts/autostart/*.ps1,
# SEM Pester (evita presumir uma versao especifica ja instalada -- Pester
# 3.4.0 vem com o Windows PowerShell 5.1, mas a sintaxe difere bastante de
# versoes mais novas; um runner proprio, trivial, evita essa presuncao por
# completo). Dot-source este arquivo, chame Test-Case pra cada caso, e no
# final Complete-Crypto10Tests pra imprimir o resumo e sair com o codigo
# certo (0 = tudo passou, 1 = alguma falha).

$Script:Crypto10TestPass = 0
$Script:Crypto10TestFail = 0
$Script:Crypto10TestFailures = New-Object System.Collections.Generic.List[string]

function Test-Case {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Body
    )
    try {
        & $Body
        $Script:Crypto10TestPass++
        Write-Host "  ok - $Name"
    } catch {
        $Script:Crypto10TestFail++
        $msg = "$Name -- $($_.Exception.Message)"
        [void]$Script:Crypto10TestFailures.Add($msg)
        Write-Host "  FAIL - $msg"
    }
}

function Assert-True {
    param([Parameter(Mandatory = $true)]$Condition, [Parameter(Mandatory = $false)][string]$Message = "esperado True, obteve False")
    if (-not $Condition) { throw $Message }
}

function Assert-False {
    param([Parameter(Mandatory = $true)]$Condition, [Parameter(Mandatory = $false)][string]$Message = "esperado False, obteve True")
    if ($Condition) { throw $Message }
}

function Assert-Equal {
    param($Expected, $Actual, [Parameter(Mandatory = $false)][string]$Message = $null)
    if ("$Expected" -ne "$Actual") {
        $m = "esperado [$Expected] mas obteve [$Actual]"
        if ($Message) { $m = "$Message -- $m" }
        throw $m
    }
}

function Assert-Null {
    param($Value, [Parameter(Mandatory = $false)][string]$Message = "esperado `$null")
    if ($null -ne $Value) { throw $Message }
}

function Assert-NotNull {
    param($Value, [Parameter(Mandatory = $false)][string]$Message = "esperado valor nao-nulo")
    if ($null -eq $Value) { throw $Message }
}

function Complete-Crypto10Tests {
    Write-Host ""
    Write-Host "=== Resumo: $($Script:Crypto10TestPass) ok, $($Script:Crypto10TestFail) falha(s) ==="
    if ($Script:Crypto10TestFail -gt 0) {
        foreach ($f in $Script:Crypto10TestFailures) { Write-Host "  - $f" }
        exit 1
    }
    exit 0
}
