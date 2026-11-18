' Claude Usage Monitor: desktop launcher.
' Starts the monitor with no console window if it is not already running,
' then opens the dashboard in your default browser.
Option Explicit
Dim sh, fso, root, url, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
url = "http://localhost:4747"

' /quiet (the sign-in shortcut): start the monitor, open nothing.
Dim quiet
quiet = WScript.Arguments.Count > 0
If quiet Then quiet = (LCase(WScript.Arguments(0)) = "/quiet")

Function IsUp()
  Dim http
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 500, 500, 500, 1500
  http.open "GET", url & "/api/whoami", False
  http.send
  IsUp = (Err.Number = 0)
  If IsUp Then IsUp = (http.status = 200)
  On Error GoTo 0
End Function

If Not IsUp() Then
  ' Window style 0 = hidden. start-remote.cmd also puts the dashboard online for the phone app.
  sh.Run "cmd /c """ & root & "\start-remote.cmd""", 0, False
  For i = 1 To 60
    WScript.Sleep 500
    If IsUp() Then Exit For
  Next
End If

If IsUp() Then
  If Not quiet Then sh.Run url
Else
  MsgBox "Claude Usage Monitor did not start." & vbCrLf & vbCrLf & _
    "Check that Node.js is installed, then look at:" & vbCrLf & root & "\data\monitor.log", vbExclamation, "Claude Usage Monitor"
End If
