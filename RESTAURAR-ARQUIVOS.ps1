# Restaura os arquivos que sumiram da pasta do jogo, a partir do acervo do Modao.
# Cada arquivo e copiado do acervo (store) de volta para onde ele deveria estar.
# Nada e apagado: arquivos que ja existem sao pulados.
$ErrorActionPreference = "Stop"
$restaurados = 0
$falhas = 0

try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\vorbisFile.dll"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\vorbisFile.dll")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\31006f890610269cc89c43b1\\vorbisFile.dll" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\vorbisFile.dll" -Force
    Write-Host "  ok   vorbisFile.dll"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\vorbisHooked.dll"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\vorbisHooked.dll")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\31006f890610269cc89c43b1\\vorbisHooked.dll" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\vorbisHooked.dll" -Force
    Write-Host "  ok   vorbisHooked.dll"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\bass.dll"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\bass.dll")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\bass.dll" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\bass.dll" -Force
    Write-Host "  ok   bass.dll"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\CLEO+.cleo"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\CLEO+.cleo")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\CLEO+.cleo" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\CLEO+.cleo" -Force
    Write-Host "  ok   CLEO+.cleo"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\FileSystemOperations.cleo"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\FileSystemOperations.cleo")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\FileSystemOperations.cleo" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\FileSystemOperations.cleo" -Force
    Write-Host "  ok   FileSystemOperations.cleo"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\IniFiles.cleo"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\IniFiles.cleo")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\IniFiles.cleo" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\IniFiles.cleo" -Force
    Write-Host "  ok   IniFiles.cleo"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\IntOperations.cleo"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\IntOperations.cleo")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\IntOperations.cleo" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\CLEO\\IntOperations.cleo" -Force
    Write-Host "  ok   IntOperations.cleo"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\scripts\\CLEO.asi"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\scripts\\CLEO.asi")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\scripts\\CLEO.asi" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\scripts\\CLEO.asi" -Force
    Write-Host "  ok   CLEO.asi"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\gta_sa.exe"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\gta_sa.exe")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\gta_sa.exe" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\gta_sa.exe" -Force
    Write-Host "  ok   gta_sa.exe"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\gta_sa.pdb"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\gta_sa.pdb")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\gta_sa.pdb" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\[SA] Essentials (pack de mods que não podem faltar no GTA SA\\gta_sa.pdb" -Force
    Write-Host "  ok   gta_sa.pdb"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\libcurl.dll"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\libcurl.dll")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\libcurl.dll" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\libcurl.dll" -Force
    Write-Host "  ok   libcurl.dll"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\FramerateVigilante\\FramerateVigilante.ini"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\FramerateVigilante\\FramerateVigilante.ini")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\modloader\\_ESSENTIALS\\FramerateVigilante\\FramerateVigilante.ini" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\FramerateVigilante\\FramerateVigilante.ini" -Force
    Write-Host "  ok   FramerateVigilante.ini"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\FramerateVigilante\\FramerateVigilante.SA.asi"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\FramerateVigilante\\FramerateVigilante.SA.asi")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\modloader\\_ESSENTIALS\\FramerateVigilante\\FramerateVigilante.SA.asi" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\FramerateVigilante\\FramerateVigilante.SA.asi" -Force
    Write-Host "  ok   FramerateVigilante.SA.asi"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\RepairGTA\\RepairGTA.SA.asi"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\RepairGTA\\RepairGTA.SA.asi")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\modloader\\_ESSENTIALS\\RepairGTA\\RepairGTA.SA.asi" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\RepairGTA\\RepairGTA.SA.asi" -Force
    Write-Host "  ok   RepairGTA.SA.asi"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\RunDLL32 Fix\\rundll32exefix.asi"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\RunDLL32 Fix\\rundll32exefix.asi")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\modloader\\_ESSENTIALS\\RunDLL32 Fix\\rundll32exefix.asi" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\RunDLL32 Fix\\rundll32exefix.asi" -Force
    Write-Host "  ok   rundll32exefix.asi"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\SilentPatch\\SilentPatchSA.asi"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\SilentPatch\\SilentPatchSA.asi")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\modloader\\_ESSENTIALS\\SilentPatch\\SilentPatchSA.asi" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\SilentPatch\\SilentPatchSA.asi" -Force
    Write-Host "  ok   SilentPatchSA.asi"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\SilentPatch\\SilentPatchSA.ini"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\SilentPatch\\SilentPatchSA.ini")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\modloader\\_ESSENTIALS\\SilentPatch\\SilentPatchSA.ini" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\SilentPatch\\SilentPatchSA.ini" -Force
    Write-Host "  ok   SilentPatchSA.ini"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\Widescreen Fix by ThirteenAG\\GTASA.WidescreenFix.asi"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\Widescreen Fix by ThirteenAG\\GTASA.WidescreenFix.asi")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\modloader\\_ESSENTIALS\\Widescreen Fix by ThirteenAG\\GTASA.WidescreenFix.asi" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\Widescreen Fix by ThirteenAG\\GTASA.WidescreenFix.asi" -Force
    Write-Host "  ok   GTASA.WidescreenFix.asi"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\Widescreen Fix by ThirteenAG\\GTASA.WidescreenFix.ini"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\Widescreen Fix by ThirteenAG\\GTASA.WidescreenFix.ini")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\modloader\\_ESSENTIALS\\Widescreen Fix by ThirteenAG\\GTASA.WidescreenFix.ini" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\Widescreen Fix by ThirteenAG\\GTASA.WidescreenFix.ini" -Force
    Write-Host "  ok   GTASA.WidescreenFix.ini"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\Windowed Mode\\III.VC.SA.WindowedMode.asi"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\Windowed Mode\\III.VC.SA.WindowedMode.asi")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\modloader\\_ESSENTIALS\\Windowed Mode\\III.VC.SA.WindowedMode.asi" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\Windowed Mode\\III.VC.SA.WindowedMode.asi" -Force
    Write-Host "  ok   III.VC.SA.WindowedMode.asi"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\Windowed Mode\\III.VC.SA.WindowedMode.ini"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\Windowed Mode\\III.VC.SA.WindowedMode.ini")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\modloader\\_ESSENTIALS\\Windowed Mode\\III.VC.SA.WindowedMode.ini" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\modloader\\_ESSENTIALS\\Windowed Mode\\III.VC.SA.WindowedMode.ini" -Force
    Write-Host "  ok   III.VC.SA.WindowedMode.ini"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\scripts\\modloader.asi"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\scripts\\modloader.asi")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\scripts\\modloader.asi" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\scripts\\modloader.asi" -Force
    Write-Host "  ok   modloader.asi"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\vorbisFile.dll"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\vorbisFile.dll")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\vorbisFile.dll" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\vorbisFile.dll" -Force
    Write-Host "  ok   vorbisFile.dll"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }
try {
  $d = Split-Path -Parent "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\vorbisHooked.dll"
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  if (-not (Test-Path -LiteralPath "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\vorbisHooked.dll")) {
    Copy-Item -LiteralPath "C:\\Users\\T\\AppData\\Roaming\\Modao\\store\\mods\\59b3c3a7e47fb1443140fb4f\\vorbisHooked.dll" -Destination "C:\\Program Files (x86)\\DODI-Repacks\\Grand Theft Auto San Andreas\\vorbisHooked.dll" -Force
    Write-Host "  ok   vorbisHooked.dll"
    $restaurados++
  }
} catch { Write-Host ("  FALHOU " + $_.Exception.Message) -ForegroundColor Red; $falhas++ }

Write-Host ""
Write-Host ("$restaurados arquivo(s) restaurado(s), $falhas falha(s)") -ForegroundColor Green
Read-Host "Enter para fechar"