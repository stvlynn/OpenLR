on run argv
    set operation to item 1 of argv
    if operation is "export" then set the clipboard to (item 3 of argv)
    tell application "System Events"
        set targetProcess to first application process whose bundle identifier is "com.apple.Photos"
        set frontmost of targetProcess to true
        if operation is "create" then
            click my waitFor(targetProcess, "AXButton", {"Create New…", "Create New..."})
            my waitFor(targetProcess, "AXTextField", {"Save As:"})
            my navigate(targetProcess, item 2 of argv)
            delay 0.5
            click my waitFor(targetProcess, "AXButton", {"OK"})
            return "Requested a new Photos library"
        end if
        if operation is "import" then
            keystroke "i" using {command down, shift down}
            my waitFor(targetProcess, "AXButton", {"Cancel"})
            my navigate(targetProcess, item 2 of argv)
            click my waitFor(targetProcess, "AXButton", {"Review for Import", "Import"})
            return "Confirmed import of the generated source"
        end if
        if operation is "export" then
            keystroke "a" using command down
            my waitForExport(targetProcess)
            keystroke "i" using command down
            set keywordField to my waitFor(targetProcess, "AXTextField", {"Add a Keyword", "Add a Keyword…", "Add Keywords"})
            set value of attribute "AXFocused" of keywordField to true
            delay 0.2
            keystroke "v" using command down
            delay 0.4
            key code 36
            delay 0.3
            keystroke "i" using command down
            click my waitForExport(targetProcess)
            set xmpToggle to my waitFor(targetProcess, "AXCheckBox", {"Export IPTC as XMP"})
            if (value of xmpToggle) is 0 then click xmpToggle
            if (value of xmpToggle) is not 1 then error "IPTC XMP export is not enabled"
            click my waitFor(targetProcess, "AXButton", {"Export"})
            my waitFor(targetProcess, "AXButton", {"Export Originals", "Export Original", "Export"})
            my navigate(targetProcess, item 2 of argv)
            click my waitFor(targetProcess, "AXButton", {"Export Originals", "Export Original", "Export"})
            return "Confirmed Photos Unmodified Original and IPTC XMP export"
        end if
    end tell
    error "Unknown Photos operation"
end run

on waitFor(targetProcess, expectedRole, expectedNames)
    tell application "System Events"
        repeat 30 times
            set ownerWindows to get windows of targetProcess
            repeat with ownerWindow in ownerWindows
                set axNodes to get entire contents of (contents of ownerWindow)
                repeat with axNode in axNodes
                    try
                        if role of axNode is expectedRole and enabled of axNode then
                            set labelText to name of axNode
                            if labelText is in expectedNames then return contents of axNode
                            set labelText to description of axNode
                            if labelText is in expectedNames then return contents of axNode
                            set labelText to value of attribute "AXPlaceholderValue" of axNode
                            if labelText is in expectedNames then return contents of axNode
                        end if
                    end try
                end repeat
            end repeat
            delay 0.15
        end repeat
    end tell
    error ("No enabled Photos accessibility element for " & item 1 of expectedNames)
end waitFor

on waitForExport(targetProcess)
    tell application "System Events"
        repeat 30 times
            set fileMenu to menu 1 of menu bar item "File" of menu bar 1 of targetProcess
            set exportEntries to get menu items of menu 1 of menu item "Export" of fileMenu
            repeat with exportAction in exportEntries
                try
                    if (name of exportAction begins with "Export Unmodified Original") and enabled of exportAction then return contents of exportAction
                end try
            end repeat
            delay 0.15
        end repeat
    end tell
    error "Photos did not enable Export Unmodified Original"
end waitForExport

on navigate(targetProcess, destination)
    set the clipboard to destination
    tell application "System Events"
        if frontmost of targetProcess is not true then error "Photos lost focus"
        set previousFocus to missing value
        try
            set previousFocus to value of attribute "AXFocusedUIElement" of targetProcess
        end try
        keystroke "g" using {command down, shift down}
        set pathEntry to missing value
        repeat 30 times
            if frontmost of targetProcess is not true then error "Photos lost focus before Go to Folder"
            try
                set currentFocus to value of attribute "AXFocusedUIElement" of targetProcess
                if (role of currentFocus is in {"AXTextField", "AXComboBox"}) and (currentFocus is not previousFocus) then
                    set pathEntry to currentFocus
                    exit repeat
                end if
            end try
            delay 0.12
        end repeat
        if pathEntry is missing value then error "Photos Go to Folder did not focus its path entry"
        set entryDescription to description of pathEntry
        if entryDescription is missing value then set entryDescription to "(none)"
        log ("Photos Go to Folder focus: " & role of pathEntry & " " & entryDescription)
        keystroke "a" using command down
        keystroke "v" using command down
        delay 0.5
        set enteredPath to value of pathEntry
        if enteredPath is not destination then
            set value of pathEntry to destination
            delay 0.5
            set enteredPath to value of pathEntry
        end if
        if enteredPath is not destination then error "Photos Go to Folder path input did not match"
        key code 36
        repeat 30 times
            set currentFocus to missing value
            try
                set currentFocus to value of attribute "AXFocusedUIElement" of targetProcess
            end try
            if currentFocus is not pathEntry then return
            delay 0.12
        end repeat
    end tell
    error "Photos Go to Folder did not close after confirmation"
end navigate
