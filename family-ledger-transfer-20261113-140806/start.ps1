Set-Location -LiteralPath $PSScriptRoot
$env:LEDGER_SHARED = '1'
node server.mjs
