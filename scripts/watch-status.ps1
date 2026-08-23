# Live view of logs/status.json (written by lib/progress.ts's report(), called from lib/refresh.ts)
# in a terminal you leave open -- Windows Task Scheduler runs the nightly refresh with no console
# of its own, so this is the "watch it happen" option instead of tailing logs\refresh\*.log by hand.
#
#   powershell -File scripts\watch-status.ps1

$statusPath = Join-Path (Split-Path -Parent $PSScriptRoot) "logs\status.json"

while ($true) {
    Clear-Host
    if (-not (Test-Path $statusPath)) {
        Write-Host "no logs\status.json yet -- no refresh run has started"
    } else {
        try {
            $s = Get-Content $statusPath -Raw | ConvertFrom-Json
            $pct = if ($s.totalStages) { [math]::Round(($s.stage / $s.totalStages) * 100) } else { 0 }
            $barLen = [math]::Floor($pct / 5)
            $bar = ("#" * $barLen).PadRight(20, "-")

            Write-Host "[$($s.status)] run $($s.runId)"
            Write-Host "Stage: $($s.currentStage) ($($s.stage)/$($s.totalStages))  $pct%"
            Write-Host "[$bar] $($s.tickersDone)/$($s.tickersTotal) tickers"
            Write-Host "Updated: $($s.updatedAt)"
            if ($s.lastError) { Write-Host "Last error: $($s.lastError)" -ForegroundColor Red }
        } catch {
            Write-Host "logs\status.json exists but isn't valid JSON yet (mid-write) -- retrying" -ForegroundColor Yellow
        }
    }
    Start-Sleep -Seconds 3
}
