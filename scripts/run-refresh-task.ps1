# Invoked by the "akeguru-refresh" Windows Task Scheduler task (see README's Deploying section) --
# not meant to be run interactively, though `powershell -File scripts\run-refresh-task.ps1` works
# fine by hand too. Wraps `npx tsx scripts/refresh-universe.ts` with a timestamped log file: a
# scheduled task has no visible console to read a failure from otherwise. RefreshLog (the Prisma
# table lib/refresh.ts already writes on completion) only gets a row if the process gets far enough
# to reach the DB -- this catches earlier failures too (node/tsx not resolving, `prisma dev` not
# running, the working directory being wrong).

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectRoot "logs\refresh"
New-Item -ItemType Directory -Force -Path $logDir -ErrorAction Stop | Out-Null

$timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$logFile = Join-Path $logDir "$timestamp.log"
$exitCode = 1

try {
    Set-Location $projectRoot -ErrorAction Stop

    # `prisma dev` (the local Postgres-compatible dev DB, see README) has to already be running for
    # refresh-universe.ts to connect at all — confirmed live it was NOT running here (README already
    # notes it drops occasionally during long-running scripts). A scheduled task can't assume a
    # terminal is open to notice and restart it by hand, so check first and self-heal.
    $devStatus = & npx prisma dev ls 2>&1 | Out-String
    if ($devStatus -notmatch "akeguru\s+running") {
        "$timestamp starting prisma dev (was not running)" | Add-Content -Path $logFile
        & npx prisma dev start akeguru *>> $logFile
        Start-Sleep -Seconds 5 # give the local DB a moment to come up before refresh connects
    }

    # Redirected via cmd.exe, not PowerShell's own `*>`/`2>&1` — Windows PowerShell 5.1 wraps a
    # native command's stderr lines as NativeCommandError objects when captured that way, which
    # (confirmed live) turns refresh-universe.ts's normal, already-handled per-ticker warnings
    # (see README's "Data source" section — yahoo-finance2 schema-validation misses on individual
    # tickers, logged and skipped, not fatal) into a false failure here. cmd's own `>`/`2>&1` never
    # goes through that stream-wrapping, so $LASTEXITCODE ends up reflecting the real exit code.
    cmd /c "npx tsx scripts\refresh-universe.ts >> `"$logFile`" 2>&1"
    $exitCode = $LASTEXITCODE
} catch {
    $_ | Out-File -FilePath $logFile -Append
    $exitCode = 1
}

if ($exitCode -ne 0) {
    Add-Content -Path (Join-Path $logDir "failures.log") -Value "$timestamp exit=$exitCode -- see $timestamp.log"
}

# Keep 30 days of per-run logs so this doesn't grow unbounded over months of daily runs.
Get-ChildItem $logDir -Filter "*.log" |
    Where-Object { $_.Name -ne "failures.log" -and $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    Remove-Item -Force

# Optional ntfy.sh push notification -- only if NTFY_TOPIC is set in .env (see README). ntfy topics
# are an unauthenticated shared name (anyone who knows it can read or post to it), so this is never
# turned on by default -- it's your topic to pick and opt into, not something to silently wire up.
# Failure here (bad topic, no network) is never allowed to change $exitCode; the refresh itself
# already succeeded or failed on its own terms above.
try {
    $envFile = Join-Path $projectRoot ".env"
    $ntfyLine = Get-Content $envFile -ErrorAction Stop | Where-Object { $_ -match '^\s*NTFY_TOPIC\s*=\s*"?([^"]+)"?\s*$' }
    if ($ntfyLine) {
        $topic = $Matches[1]
        $statusPath = Join-Path $projectRoot "logs\status.json"
        $s = Get-Content $statusPath -Raw | ConvertFrom-Json
        $msg = if ($exitCode -eq 0) {
            "akeguru refresh done: $($s.tickersDone)/$($s.tickersTotal) tickers ($($s.status))"
        } else {
            "akeguru refresh FAILED at stage '$($s.currentStage)': $($s.lastError)"
        }
        Invoke-RestMethod -Uri "https://ntfy.sh/$topic" -Method Post -Body $msg -ErrorAction Stop | Out-Null
    }
} catch {
    Add-Content -Path $logFile -Value "ntfy notification failed (non-fatal): $_"
}

exit $exitCode
