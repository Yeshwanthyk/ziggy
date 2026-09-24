on run argv
	if (count of argv) is 0 then my failWith("INVALID_ARGUMENTS", "Missing operation")
	set operationName to item 1 of argv
	
	if operationName is "list-incomplete" then
		if (count of argv) is not 2 then my failWith("INVALID_ARGUMENTS", "list-incomplete expects 1 argument")
		return my listIncomplete(item 2 of argv)
	else if operationName is "list-due" then
		if (count of argv) is not 5 then my failWith("INVALID_ARGUMENTS", "list-due expects 4 arguments")
		return my listDue((item 2 of argv) as integer, (item 3 of argv) as integer, (item 4 of argv) as integer, item 5 of argv)
	else if operationName is "create" then
		if (count of argv) is not 9 then my failWith("INVALID_ARGUMENTS", "create expects 8 arguments")
		return my createReminder(item 2 of argv, item 3 of argv, item 4 of argv, (item 5 of argv) as integer, (item 6 of argv) as integer, (item 7 of argv) as integer, (item 8 of argv) as integer, (item 9 of argv) as integer)
	else if operationName is "reschedule" then
		if (count of argv) is not 9 then my failWith("INVALID_ARGUMENTS", "reschedule expects 8 arguments")
		return my rescheduleReminder(item 2 of argv, item 3 of argv, item 4 of argv, (item 5 of argv) as integer, (item 6 of argv) as integer, (item 7 of argv) as integer, (item 8 of argv) as integer, (item 9 of argv) as integer)
	else if operationName is "move" then
		if (count of argv) is not 4 then my failWith("INVALID_ARGUMENTS", "move expects 3 arguments")
		return my moveReminder(item 2 of argv, item 3 of argv, item 4 of argv)
	else if operationName is "complete" then
		if (count of argv) is not 3 then my failWith("INVALID_ARGUMENTS", "complete expects 2 arguments")
		return my completeReminder(item 2 of argv, item 3 of argv)
	else if operationName is "delete" then
		if (count of argv) is not 4 then my failWith("INVALID_ARGUMENTS", "delete expects 3 arguments")
		return my deleteReminder(item 2 of argv, item 3 of argv, item 4 of argv)
	else
		my failWith("INVALID_OPERATION", "Unsupported operation")
	end if
end run

on listIncomplete(requestedListName)
	if requestedListName is "" then
		tell application "Reminders" to set matchingReminders to every reminder whose completed is false
	else
		set targetList to my exactList(requestedListName)
		tell application "Reminders" to set matchingReminders to every reminder of targetList whose completed is false
	end if
	
	if (count of matchingReminders) is 0 then return "No incomplete reminders."
	set rows to {}
	tell application "Reminders"
		repeat with reminderItem in matchingReminders
			set listName to name of container of reminderItem as text
			set reminderName to name of reminderItem as text
			set end of rows to listName & " — " & reminderName
		end repeat
	end tell
	return my joined(rows)
end listIncomplete

on listDue(targetYear, targetMonth, targetDay, requestedListName)
	set dayStart to my absoluteDate(targetYear, targetMonth, targetDay, 0, 0)
	set dayEnd to dayStart + 1 * days
	
	if requestedListName is "" then
		tell application "Reminders"
			set timedReminders to every reminder whose completed is false and due date is greater than or equal to dayStart and due date is less than dayEnd
			set allDayReminders to every reminder whose completed is false and allday due date is greater than or equal to dayStart and allday due date is less than dayEnd
		end tell
	else
		set targetList to my exactList(requestedListName)
		tell application "Reminders"
			set timedReminders to every reminder of targetList whose completed is false and due date is greater than or equal to dayStart and due date is less than dayEnd
			set allDayReminders to every reminder of targetList whose completed is false and allday due date is greater than or equal to dayStart and allday due date is less than dayEnd
		end tell
	end if
	
	set matchingReminders to my uniqueById(timedReminders, allDayReminders)
	if (count of matchingReminders) is 0 then return "No incomplete reminders due on that date."
	set rows to {}
	tell application "Reminders"
		repeat with reminderItem in matchingReminders
			set listName to name of container of reminderItem as text
			set reminderName to name of reminderItem as text
			set allDayValue to allday due date of reminderItem
			if allDayValue is not missing value then
				set dueText to my formattedDate(allDayValue, "all-day")
			else
				set dueText to my formattedDate(due date of reminderItem, "timed")
			end if
			set end of rows to listName & " — " & reminderName & " (" & dueText & ")"
		end repeat
	end tell
	return my joined(rows)
end listDue

on createReminder(reminderName, destinationListName, dueKind, targetYear, targetMonth, targetDay, targetHour, targetMinute)
	set destinationList to my exactList(destinationListName)
	set duplicateItems to my exactIncompleteReminders(reminderName, destinationListName)
	if (count of duplicateItems) is greater than 0 then my failWith("DUPLICATE_REMINDER", "An incomplete reminder named " & my quoted(reminderName) & " already exists in " & destinationListName)
	
	if dueKind is "none" then
		set targetDate to missing value
	else if dueKind is "all-day" or dueKind is "timed" then
		set targetDate to my absoluteDate(targetYear, targetMonth, targetDay, targetHour, targetMinute)
	else
		my failWith("INVALID_DATE_KIND", "Due kind must be none, all-day, or timed")
	end if
	
	tell application "Reminders"
		if dueKind is "none" then
			set createdReminder to make new reminder at end of reminders of destinationList with properties {name:reminderName}
		else if dueKind is "all-day" then
			set createdReminder to make new reminder at end of reminders of destinationList with properties {name:reminderName, allday due date:targetDate}
		else
			set createdReminder to make new reminder at end of reminders of destinationList with properties {name:reminderName, due date:targetDate}
		end if
		set createdId to id of createdReminder as text
		set destinationId to id of destinationList as text
	end tell
	
	set verifiedReminder to my reminderById(createdId)
	my verifyIdentity(verifiedReminder, createdId, reminderName, destinationId, false)
	if dueKind is not "none" then my verifyDue(verifiedReminder, dueKind, targetDate)
	
	if dueKind is "none" then return "Created " & my quoted(reminderName) & " in " & destinationListName
	return "Created " & my quoted(reminderName) & " in " & destinationListName & " — " & my formattedDate(targetDate, dueKind)
end createReminder

on rescheduleReminder(reminderName, sourceListName, dueKind, targetYear, targetMonth, targetDay, targetHour, targetMinute)
	if dueKind is not "all-day" and dueKind is not "timed" then my failWith("INVALID_DATE_KIND", "Due kind must be all-day or timed")
	set reminderItem to my uniqueIncompleteReminder(reminderName, sourceListName)
	set targetDate to my absoluteDate(targetYear, targetMonth, targetDay, targetHour, targetMinute)
	
	tell application "Reminders"
		set reminderId to id of reminderItem as text
		set sourceList to container of reminderItem
		set sourceListId to id of sourceList as text
		set sourceListDisplayName to name of sourceList as text
		if dueKind is "all-day" then
			set allday due date of reminderItem to targetDate
		else
			set due date of reminderItem to targetDate
		end if
	end tell
	
	set verifiedReminder to my reminderById(reminderId)
	my verifyIdentity(verifiedReminder, reminderId, reminderName, sourceListId, false)
	my verifyDue(verifiedReminder, dueKind, targetDate)
	return "Rescheduled " & my quoted(reminderName) & " in " & sourceListDisplayName & " — " & my formattedDate(targetDate, dueKind)
end rescheduleReminder

on moveReminder(reminderName, sourceListName, destinationListName)
	my failWith("MOVE_UNSUPPORTED", "This macOS Reminders scripting interface does not persist list moves reliably; no change was made")
end moveReminder

on completeReminder(reminderName, sourceListName)
	set incompleteItems to my exactIncompleteReminders(reminderName, sourceListName)
	if (count of incompleteItems) is greater than 1 then my failWith("AMBIGUOUS_REMINDER", my candidateMessage(incompleteItems))
	if (count of incompleteItems) is 0 then
		set completedItems to my exactCompletedReminders(reminderName, sourceListName)
		if (count of completedItems) is greater than 1 then my failWith("AMBIGUOUS_REMINDER", my candidateMessage(completedItems))
		if (count of completedItems) is 1 then
			tell application "Reminders" to set completedListName to name of container of item 1 of completedItems as text
			return my quoted(reminderName) & " is already complete in " & completedListName
		end if
		my failWith("REMINDER_NOT_FOUND", "No exact incomplete reminder named " & my quoted(reminderName) & " was found")
	end if
	
	set reminderItem to item 1 of incompleteItems
	tell application "Reminders"
		set reminderId to id of reminderItem as text
		set sourceList to container of reminderItem
		set sourceListId to id of sourceList as text
		set sourceListDisplayName to name of sourceList as text
		set oldDue to due date of reminderItem
		set oldAllDayDue to allday due date of reminderItem
		set completed of reminderItem to true
	end tell
	
	set verifiedReminder to my reminderById(reminderId)
	my verifyIdentity(verifiedReminder, reminderId, reminderName, sourceListId, true)
	tell application "Reminders"
		if not my sameValue(due date of verifiedReminder, oldDue) then my failWith("VERIFY_FAILED", "Completion changed the due date")
		if not my sameValue(allday due date of verifiedReminder, oldAllDayDue) then my failWith("VERIFY_FAILED", "Completion changed the all-day due date")
	end tell
	return "Completed " & my quoted(reminderName) & " in " & sourceListDisplayName
end completeReminder

on deleteReminder(reminderName, sourceListName, confirmation)
	if confirmation is not "confirmed" then my failWith("CONFIRMATION_REQUIRED", "Deletion requires explicit confirmation")
	if sourceListName is "" then my failWith("INVALID_ARGUMENTS", "Deletion requires an exact source list")
	set matchingItems to my exactAllReminders(reminderName, sourceListName)
	if (count of matchingItems) is 0 then my failWith("REMINDER_NOT_FOUND", "No exact reminder named " & my quoted(reminderName) & " was found in " & sourceListName)
	if (count of matchingItems) is greater than 1 then my failWith("AMBIGUOUS_REMINDER", my candidateMessage(matchingItems))
	set reminderItem to item 1 of matchingItems
	
	tell application "Reminders"
		set reminderId to id of reminderItem as text
		set sourceListDisplayName to name of container of reminderItem as text
		delete reminderItem
		set remainingItems to every reminder whose id is reminderId
	end tell
	if (count of remainingItems) is not 0 then my failWith("VERIFY_FAILED", "The reminder still exists after delete")
	return "Deleted " & my quoted(reminderName) & " from " & sourceListDisplayName
end deleteReminder

on exactList(requestedName)
	tell application "Reminders" to set narrowedLists to every list whose name is requestedName
	set exactLists to {}
	tell application "Reminders"
		repeat with listItem in narrowedLists
			if my sameText(name of listItem as text, requestedName) then set end of exactLists to listItem
		end repeat
	end tell
	if (count of exactLists) is 0 then my failWith("LIST_NOT_FOUND", "No exact list named " & my quoted(requestedName) & " was found")
	if (count of exactLists) is greater than 1 then my failWith("AMBIGUOUS_LIST", "More than one exact list named " & my quoted(requestedName) & " exists")
	return item 1 of exactLists
end exactList

on exactIncompleteReminders(requestedName, sourceListName)
	if sourceListName is "" then
		tell application "Reminders" to set narrowedItems to every reminder whose name is requestedName and completed is false
	else
		set sourceList to my exactList(sourceListName)
		tell application "Reminders" to set narrowedItems to every reminder of sourceList whose name is requestedName and completed is false
	end if
	return my exactCaseReminders(narrowedItems, requestedName)
end exactIncompleteReminders

on exactCompletedReminders(requestedName, sourceListName)
	if sourceListName is "" then
		tell application "Reminders" to set narrowedItems to every reminder whose name is requestedName and completed is true
	else
		set sourceList to my exactList(sourceListName)
		tell application "Reminders" to set narrowedItems to every reminder of sourceList whose name is requestedName and completed is true
	end if
	return my exactCaseReminders(narrowedItems, requestedName)
end exactCompletedReminders

on exactAllReminders(requestedName, sourceListName)
	if sourceListName is "" then
		tell application "Reminders" to set narrowedItems to every reminder whose name is requestedName
	else
		set sourceList to my exactList(sourceListName)
		tell application "Reminders" to set narrowedItems to every reminder of sourceList whose name is requestedName
	end if
	return my exactCaseReminders(narrowedItems, requestedName)
end exactAllReminders

on exactCaseReminders(narrowedItems, requestedName)
	set exactItems to {}
	tell application "Reminders"
		repeat with reminderItem in narrowedItems
			if my sameText(name of reminderItem as text, requestedName) then set end of exactItems to reminderItem
		end repeat
	end tell
	return exactItems
end exactCaseReminders

on uniqueIncompleteReminder(requestedName, sourceListName)
	set exactItems to my exactIncompleteReminders(requestedName, sourceListName)
	if (count of exactItems) is 0 then my failWith("REMINDER_NOT_FOUND", "No exact incomplete reminder named " & my quoted(requestedName) & " was found")
	if (count of exactItems) is greater than 1 then my failWith("AMBIGUOUS_REMINDER", my candidateMessage(exactItems))
	return item 1 of exactItems
end uniqueIncompleteReminder

on reminderById(requestedId)
	tell application "Reminders" to set narrowedItems to every reminder whose id is requestedId
	set exactItems to {}
	tell application "Reminders"
		repeat with reminderItem in narrowedItems
			if my sameText(id of reminderItem as text, requestedId) then set end of exactItems to reminderItem
		end repeat
	end tell
	if (count of exactItems) is not 1 then my failWith("VERIFY_FAILED", "Could not resolve exactly one reminder by its captured ID")
	return item 1 of exactItems
end reminderById

on verifyIdentity(reminderItem, expectedId, expectedName, expectedListId, expectedCompleted)
	tell application "Reminders"
		if not my sameText(id of reminderItem as text, expectedId) then my failWith("VERIFY_FAILED", "Reminder ID changed")
		if not my sameText(name of reminderItem as text, expectedName) then my failWith("VERIFY_FAILED", "Reminder name changed")
		if not my sameText(id of container of reminderItem as text, expectedListId) then my failWith("VERIFY_FAILED", "Reminder list did not match")
		if completed of reminderItem is not expectedCompleted then my failWith("VERIFY_FAILED", "Reminder completion state did not match")
	end tell
end verifyIdentity

on verifyDue(reminderItem, dueKind, expectedDate)
	tell application "Reminders"
		if dueKind is "all-day" then
			set actualDate to allday due date of reminderItem
		else
			set actualDate to due date of reminderItem
		end if
	end tell
	if actualDate is missing value then my failWith("VERIFY_FAILED", "The requested due date kind was not set")
	if not my sameDateComponents(actualDate, expectedDate, dueKind) then my failWith("VERIFY_FAILED", "The due date components did not match")
end verifyDue

on absoluteDate(targetYear, targetMonth, targetDay, targetHour, targetMinute)
	set targetDate to current date
	set day of targetDate to 1
	set year of targetDate to targetYear
	set month of targetDate to targetMonth
	set day of targetDate to targetDay
	set hours of targetDate to targetHour
	set minutes of targetDate to targetMinute
	set seconds of targetDate to 0
	if year of targetDate is not targetYear or (month of targetDate as integer) is not targetMonth or day of targetDate is not targetDay or hours of targetDate is not targetHour or minutes of targetDate is not targetMinute then my failWith("INVALID_DATE", "Invalid absolute local date components")
	return targetDate
end absoluteDate

on sameDateComponents(leftDate, rightDate, dueKind)
	if year of leftDate is not year of rightDate then return false
	if (month of leftDate as integer) is not (month of rightDate as integer) then return false
	if day of leftDate is not day of rightDate then return false
	if dueKind is "timed" then
		if hours of leftDate is not hours of rightDate then return false
		if minutes of leftDate is not minutes of rightDate then return false
	end if
	return true
end sameDateComponents

on uniqueById(firstItems, secondItems)
	set combinedItems to {}
	set seenIds to {}
	tell application "Reminders"
		repeat with reminderItem in firstItems & secondItems
			set reminderId to id of reminderItem as text
			set alreadySeen to false
			repeat with seenId in seenIds
				if my sameText(seenId as text, reminderId) then set alreadySeen to true
			end repeat
			if not alreadySeen then
				set end of seenIds to reminderId
				set end of combinedItems to reminderItem
			end if
		end repeat
	end tell
	return combinedItems
end uniqueById

on candidateMessage(reminderItems)
	set rows to {}
	tell application "Reminders"
		repeat with reminderItem in reminderItems
			set end of rows to (name of container of reminderItem as text) & " — " & (name of reminderItem as text)
		end repeat
	end tell
	return "More than one exact reminder matched: " & my joined(rows)
end candidateMessage

on formattedDate(value, dueKind)
	set dateText to (year of value as text) & "-" & my padded(month of value as integer) & "-" & my padded(day of value)
	if dueKind is "timed" then return dateText & " at " & my padded(hours of value) & ":" & my padded(minutes of value)
	return dateText
end formattedDate

on padded(value)
	return text -2 thru -1 of ("0" & (value as text))
end padded

on quoted(value)
	return "“" & value & "”"
end quoted

on joined(rows)
	set oldDelimiters to AppleScript's text item delimiters
	set AppleScript's text item delimiters to linefeed
	set joinedText to rows as text
	set AppleScript's text item delimiters to oldDelimiters
	return joinedText
end joined

on sameText(leftText, rightText)
	considering case
		return (leftText as text) is (rightText as text)
	end considering
end sameText

on sameValue(leftValue, rightValue)
	if leftValue is missing value and rightValue is missing value then return true
	if leftValue is missing value or rightValue is missing value then return false
	considering case
		return leftValue is rightValue
	end considering
end sameValue

on failWith(errorCode, errorMessage)
	error errorCode & ": " & errorMessage number -2700
end failWith
