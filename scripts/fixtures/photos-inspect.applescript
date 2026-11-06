on run argv
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
        set createButton to missing value
        repeat with ownerWindow in windows of targetProcess
            repeat with axNode in entire contents of ownerWindow
                if role of axNode is "AXButton" then
                    set labelText to name of axNode
                    if labelText is not missing value and labelText begins with "Create New" then
                        set createButton to contents of axNode
                        exit repeat
                    end if
                end if
            end repeat
        end repeat
        if createButton is missing value then error "Photos did not open its library chooser"
        log ("Photos library chooser: " & name of createButton)
        click createButton
        delay 0.8
        repeat with ownerWindow in windows of targetProcess
            log ("window: " & name of ownerWindow)
            set axNodes to entire contents of ownerWindow
            repeat with elementIndex from 1 to (count axNodes)
                if elementIndex > 100 then exit repeat
                set axNode to item elementIndex of axNodes
                try
                    set labelText to name of axNode
                    if labelText is missing value then set labelText to description of axNode
                    if labelText is missing value then set labelText to ""
                    log ((role of axNode) & " | " & labelText)
                end try
            end repeat
        end repeat
        return "Observed the Photos library creation panel"
    end tell
end run
