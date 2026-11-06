on run argv
    set processId to (item 1 of argv) as integer
    set operation to item 2 of argv
    tell application "System Events"
        set targetProcess to first application process whose unix id is processId
        if bundle identifier of targetProcess is not "app.openlr.desktop" then error "Unexpected target process"
        if operation is "preflight" then
            set frontmost of targetProcess to true
            if (count of windows of targetProcess) is 0 then error "No native OpenLR workspace window"
            return name of menu item "Export with previous settings" of menu 1 of menu bar item "File" of menu bar 1 of targetProcess
        end if
        if operation is "open-save" then
            if frontmost of targetProcess is not true then error "OpenLR is no longer frontmost"
            click menu item "Export with previous settings" of menu 1 of menu bar item "File" of menu bar 1 of targetProcess
            return "menu action"
        end if
        set panelKind to item 3 of argv
        set targetPanel to my nativePanel(targetProcess, panelKind)
        if operation is "observe" then
            if targetPanel is missing value then return "pending"
            set observedButton to my panelButton(targetPanel, panelKind)
            return (role of targetPanel) & " " & (name of observedButton) & " / Cancel"
        end if
        if targetPanel is missing value then error "Expected the observed native panel to remain open"
        if operation is "navigate" then
            set destination to item 4 of argv
            if frontmost of targetProcess is not true then error "OpenLR is no longer frontmost"
            set previousFocus to missing value
            try
                set previousFocus to value of attribute "AXFocusedUIElement" of targetProcess
            end try
            keystroke "g" using {command down, shift down}
            set pathEntryReady to false
            set focusedRole to "unavailable"
            repeat 30 times
                if frontmost of targetProcess is not true then error "OpenLR lost focus before Go to Folder"
                try
                    set focusedControl to value of attribute "AXFocusedUIElement" of targetProcess
                    set focusedRole to role of focusedControl
                    if (focusedRole is in {"AXTextField", "AXComboBox"}) and (focusedControl is not previousFocus) then
                        set pathEntryReady to true
                        exit repeat
                    end if
                end try
                delay 0.12
            end repeat
            if not pathEntryReady then error "Go to Folder did not focus a new path entry; last role " & focusedRole
            keystroke "a" using command down
            keystroke destination
            delay 0.4
            key code 36
            return "entered path"
        end if
        if operation is "accept" then
            set acceptButton to my panelButton(targetPanel, panelKind)
            if not enabled of acceptButton then return "pending"
            click acceptButton
            return "accepted"
        end if
        if operation is "cancel" then
            set cancelButton to my panelButton(targetPanel, "cancel")
            click cancelButton
            return "canceled"
        end if
    end tell
    error "Unknown dialog operation"
end run

on nativePanel(targetProcess, panelKind)
    tell application "System Events"
        repeat with ownerWindow in (windows of targetProcess)
            repeat with childSheet in (sheets of ownerWindow)
                if my isPanel(contents of childSheet, panelKind) then return contents of childSheet
            end repeat
            if (subrole of ownerWindow) is in {"AXDialog", "AXSystemDialog"} then
                if my isPanel(contents of ownerWindow, panelKind) then return contents of ownerWindow
            end if
        end repeat
    end tell
    return missing value
end nativePanel

on isPanel(candidate, panelKind)
    if my panelButton(candidate, "cancel") is missing value then return false
    return my panelButton(candidate, panelKind) is not missing value
end isPanel

on panelButton(candidate, panelKind)
    if panelKind is "cancel" then
        set axAttribute to "AXCancelButton"
        set buttonNames to {"Cancel"}
    else if panelKind is "save" then
        set axAttribute to "AXDefaultButton"
        set buttonNames to {"Save"}
    else if panelKind is "folder" then
        set axAttribute to "AXDefaultButton"
        set buttonNames to {"Open", "Choose"}
    else
        error "Unknown panel kind"
    end if
    tell application "System Events"
        try
            set candidateButton to value of attribute axAttribute of candidate
            if name of candidateButton is in buttonNames then return candidateButton
        end try
        repeat with candidateButton in (buttons of candidate)
            if name of candidateButton is in buttonNames then return contents of candidateButton
        end repeat
    end tell
    return missing value
end panelButton
