param(
  [Parameter(Mandatory)]
  [string]$Directory,

  [ValidatePattern('^[A-Za-z0-9_]+$')]
  [string]$Database = 'eco_reco',

  [ValidatePattern('^[A-Za-z0-9_-]+$')]
  [string]$LoginPath = 'ecoreco-backup',

  [string]$MysqlDump = 'mysqldump.exe'
)

$ErrorActionPreference = 'Stop'
$destination = New-Item -ItemType Directory -Path $Directory -Force
$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfff')
$file = Join-Path $destination.FullName "$Database-$stamp.sql"
$partial = "$file.partial"
$options = @(
  "--login-path=$LoginPath", '--single-transaction', '--no-tablespaces',
  '--set-gtid-purged=OFF', '--default-character-set=utf8mb4', "--result-file=$partial", $Database
)

try {
  & $MysqlDump @options
  if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $partial -PathType Leaf) -or
      (Get-Item -LiteralPath $partial).Length -eq 0) {
    throw 'No se pudo completar el respaldo de MySQL.'
  }
  Move-Item -LiteralPath $partial -Destination $file
  Write-Output $file
} finally {
  if (Test-Path -LiteralPath $partial -PathType Leaf) {
    Remove-Item -LiteralPath $partial -Force
  }
}
