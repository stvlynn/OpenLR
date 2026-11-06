param([Parameter(Mandatory)][string]$Installer)

$ErrorActionPreference = 'Stop'
if (!$env:RUNNER_TEMP -or $env:GITHUB_ACTIONS -ne 'true') { throw 'Use a fresh disposable Windows runner' }
$config = Get-Content -LiteralPath "$PSScriptRoot/../mygo.json" -Raw | ConvertFrom-Json
$destination = Join-Path $env:RUNNER_TEMP ("OpenLR Install " + [guid]::NewGuid().ToString('N'))
$uninstaller = Join-Path $destination 'Uninstall.exe'
$executable = Join-Path $destination 'OpenLR.exe'
$registry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$($config.identifier)"
$classes = 'HKCU:\Software\Classes'
$extensions = $config.fileAssociations.ext
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'OpenLR.lnk'
if ((Test-Path -LiteralPath $registry) -or (Test-Path -LiteralPath $shortcut)) { throw 'Expected a fresh runner account' }
foreach ($extension in $extensions) {
    if (Test-Path -LiteralPath "$classes\$($config.identifier).$extension") { throw "Existing OpenLR class for $extension" }
}
try {
    $install = Start-Process -FilePath (Resolve-Path -LiteralPath $Installer).Path -ArgumentList "/S /D=$destination" -WindowStyle Hidden -PassThru -Wait
    if ($install.ExitCode -ne 0) { throw "Installer exited $($install.ExitCode)" }
    if ((Get-ItemProperty -LiteralPath $registry).InstallLocation -ne $destination) { throw 'InstallLocation mismatch' }
    $shell = New-Object -ComObject WScript.Shell
    if (!(Test-Path -LiteralPath $shortcut) -or $shell.CreateShortcut($shortcut).TargetPath -ne $executable) { throw 'Start Menu shortcut mismatch' }
    foreach ($extension in $extensions) {
        $class = "$($config.identifier).$extension"
        $command = (Get-Item -LiteralPath "$classes\$class\shell\open\command").GetValue('')
        if ($command -ne ('"{0}" "%1"' -f $executable)) { throw "Open command mismatch for $extension" }
        if ((Get-Item -LiteralPath "$classes\.$extension\OpenWithProgids").GetValueNames() -notcontains $class) { throw "Missing Open With entry for $extension" }
    }
    node "$PSScriptRoot/native-installed-cli-smoke.mjs" $executable (Join-Path $destination 'cli/openlr.mjs')
    if ($LASTEXITCODE -ne 0) { throw "Installed CLI verification exited $LASTEXITCODE" }
} finally {
    if (Test-Path -LiteralPath $uninstaller) {
        $remove = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
        if ($remove.ExitCode -ne 0) { throw "Uninstaller exited $($remove.ExitCode)" }
    }
}
if ((Test-Path -LiteralPath $destination) -or (Test-Path -LiteralPath $registry) -or (Test-Path -LiteralPath $shortcut)) { throw 'Uninstall left installation files or integration' }
foreach ($extension in $extensions) {
    $class = "$($config.identifier).$extension"
    if (Test-Path -LiteralPath "$classes\$class") { throw "Uninstall left class for $extension" }
    $openWith = Get-Item -LiteralPath "$classes\.$extension\OpenWithProgids" -ErrorAction SilentlyContinue
    if ($openWith -and $openWith.GetValueNames() -contains $class) { throw "Uninstall left Open With entry for $extension" }
}
Write-Output "Installer and uninstaller verified with $($extensions.Count) file associations."
