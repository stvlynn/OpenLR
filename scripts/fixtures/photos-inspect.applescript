tell application "System Events"
    repeat 50 times
        if exists (first application process whose bundle identifier is "com.apple.Photos") then
            set targetProcess to first application process whose bundle identifier is "com.apple.Photos"
            if (count of windows of targetProcess) > 0 then exit repeat
        end if
        delay 0.2
    end repeat
    if (count of windows of targetProcess) is 0 then error "Photos has no accessible windows"
    set frontmost of targetProcess to true
    repeat with owner in windows of targetProcess
        log ("window: " & name of owner)
        set elements to entire contents of owner
        repeat with elementIndex from 1 to (count elements)
            if elementIndex > 140 then exit repeat
            set control to item elementIndex of elements
            try
                set controlName to name of control
                if controlName is missing value then set controlName to description of control
                if controlName is missing value then set controlName to ""
                log ((role of control) & " | " & controlName)
            end try
        end repeat
    end repeat
    set fileMenu to menu 1 of menu bar item "File" of menu bar 1 of targetProcess
    repeat with fileAction in menu items of fileMenu
        try
            log ("File | " & (name of fileAction) & " | " & ((enabled of fileAction) as text))
            if name of fileAction is "Export" then
                repeat with exportAction in menu items of menu 1 of fileAction
                    log ("Export | " & (name of exportAction) & " | " & ((enabled of exportAction) as text))
                end repeat
            end if
        end try
    end repeat
end tell
