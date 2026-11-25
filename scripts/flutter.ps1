# Runs Flutter with Talkie's Android toolchain (SDKs on F:\SDKs) without changing system settings.
#   ./scripts/flutter.ps1 build apk --debug
$root = Split-Path -Parent $PSScriptRoot
$env:ANDROID_HOME = 'F:\SDKs\android-sdk'
$env:ANDROID_SDK_ROOT = 'F:\SDKs\android-sdk'
$env:JAVA_HOME = 'F:\SDKs\jdk21'
# libsodium is built from source for Android: it needs Git Bash and GNU make on PATH.
$env:Path = "F:\SDKs\flutter\bin;F:\SDKs\flutter\bin\cache\dart-sdk\bin;F:\SDKs\jdk21\bin;C:\Program Files\Git\bin;$root\tools\bin;F:\SDKs\android-sdk\platform-tools;$env:Path"
Push-Location (Join-Path $root 'apps\mobile')
try { & flutter @args; exit $LASTEXITCODE } finally { Pop-Location }
