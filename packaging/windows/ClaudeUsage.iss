; Claude Usage Monitor: Windows installer (Inno Setup 6).
; Build: node packaging/prepare.js windows, then
;   iscc /DAppVersion=1.6.0 packaging\windows\ClaudeUsage.iss   ->  dist\ClaudeUsageSetup.exe
; Installs for the current user only (no administrator rights), with its own Node.js and cloudflared.

#ifndef AppVersion
  #define AppVersion "1.7.0"
#endif

[Setup]
AppId={{8F2A6C1E-4B7D-4E3A-9C1F-2D5E6A7B8C9D}
AppName=Claude Usage Monitor
AppVersion={#AppVersion}
AppVerName=Claude Usage Monitor {#AppVersion}
AppPublisher=Claude Usage Monitor
VersionInfoVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\Claude Usage Monitor
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir=..\..\dist
OutputBaseFilename=ClaudeUsageSetup
SetupIconFile=..\..\desktop\icon.ico
UninstallDisplayIcon={app}\desktop\icon.ico
UninstallDisplayName=Claude Usage Monitor
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=no

[Tasks]
Name: "desktopicon"; Description: "Add a Desktop shortcut"
Name: "startup"; Description: "Start the monitor when I sign in to Windows (needed for your phone to keep updating)"

[Files]
Source: "..\..\build\stage\windows\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\..\desktop\stop.ps1"; Flags: dontcopy

[Icons]
Name: "{autoprograms}\Claude Usage Monitor"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\desktop\launch.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\desktop\icon.ico"; Comment: "Open your Claude Code usage dashboard"
Name: "{autodesktop}\Claude Usage Monitor"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\desktop\launch.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\desktop\icon.ico"; Tasks: desktopicon
Name: "{userstartup}\Claude Usage Monitor"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\desktop\launch.vbs"" /quiet"; WorkingDir: "{app}"; IconFilename: "{app}\desktop\icon.ico"; Tasks: startup

[Run]
; Makes this computer's pairing code (keeps the one it has when updating).
Filename: "{app}\node\node.exe"; Parameters: """{app}\scripts\setup-address-finder.js"""; WorkingDir: "{app}"; Flags: runhidden; StatusMsg: "Making your pairing code..."
Filename: "{sys}\wscript.exe"; Parameters: """{app}\desktop\launch.vbs"""; WorkingDir: "{app}"; Description: "Open Claude Usage Monitor"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\desktop\stop.ps1"" -Dir ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "StopMonitor"

[UninstallDelete]
; Your data folder (pairing code, friends, limit history) stays, so reinstalling keeps your phone paired.
Type: filesandordirs; Name: "{app}\reports"

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  { Stop a running monitor first, so its files can be replaced. }
  ExtractTemporaryFile('stop.ps1');
  Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\stop.ps1') + '" -Dir "' + ExpandConstant('{app}') + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;
