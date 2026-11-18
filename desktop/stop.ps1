# Stops Claude Usage Monitor: asks it to quit (which also closes its tunnel), then ends anything
# still running from this install's folder. Used by the Windows installer before it updates or
# removes files.
param([string]$Dir = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))
try {
  Invoke-WebRequest -UseBasicParsing -Method Post -Uri 'http://localhost:4747/api/quit' -Headers @{ Origin = 'http://localhost:4747' } -TimeoutSec 3 | Out-Null
  Start-Sleep -Milliseconds 1200
} catch { }
$root = $null
try { $root = (Resolve-Path -LiteralPath $Dir -ErrorAction Stop).Path.TrimEnd('\') + '\' } catch { }
if ($root) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
