# Discord Storytelling Bot - Logic Errors and Issues Report

### 4. Transaction Management Across Multiple Connections
**TODO**: check where connection needs to be closed...?
---

## High Priority Issues (Will Cause Malfunctions)

### 8. Thread Permission Issues TODO
**Location:** `storybot.js` - `NextTurn()` function (lines ~347-368) and `utilities.js` - `createThread()` function

**Problem:** The code tries to use `thread.permissionOverwrites.create()` on thread objects. Discord threads don't support permission overwrites like channels do. Threads inherit permissions from their parent channel.

**Impact:** Permission setting will fail with errors. The thread will still be created but permissions won't work as expected. For private threads, users won't be automatically added properly.

**Fix:** For public threads, rely on parent channel permissions. For private threads, use `thread.members.add()` to add specific users. Remove the permissionOverwrites code.


### 11. Inconsistent Turn Status Values
**Location:** Throughout codebase

**Problem:** Turn status uses numeric codes (0, 1, 2, 3) but their meanings aren't clearly documented:
- Status 1 = active (most places)
- Status 0 = ended (some places)  
- Status 2 = completed (in handleFinalizeEntry)
- Status 3 = skipped (in handleSkipTurn)

But in the initial turn creation it defaults to 0, which conflicts with other uses.

**Impact:** Confusion and potential logic errors when querying turn status. Different developers might use different values for the same meaning.

**Fix:** Use an ENUM in the database schema or document the meanings clearly at the top of files. Consider using named constants in code like `TURN_STATUS_ACTIVE = 1`.

---

### 12. Empty Writers Array Not Handled
**Location:** `storybot.js` - `PickNextWriter()` function (line ~267)

**Problem:** If `writers` array is empty (no active writers in story), the function will try to access `writers[0].story_writer_id` or perform operations on an empty array, causing errors.

**Impact:** Rare but possible scenario if all writers leave a story. Will crash when trying to pick next writer.

**Fix:** Add check:
```javascript
if (writers.length === 0) {
  throw new Error('No active writers in story');
}
```

---

### 13. Story Thread vs Turn Thread Confusion
**Location:** `storybot.js` - `NextTurn()` function (line ~315)

**Problem:** Stories have a `story_thread_id` (the main story thread), and turns can have their own `thread_id` (for normal mode), but in quick mode the code references `writer.story_thread_id` which might not be set in the writer object (it's in the story object).

**Impact:** Quick mode notifications might fail or point to the wrong thread.

**Fix:** Query the story table to get the correct story_thread_id for quick mode.

---

### 14. Story Status Check Missing
**Location:** `commands/story.js` - `validateStoryAccess()` function (line ~685)

**Problem:** The function checks if `story_status !== 1` (not active) and rejects, but for the write command context, this makes sense. However, this same validation is used for other operations where checking multiple status values might be appropriate.

**Impact:** Rigid validation that might prevent legitimate operations on paused stories.

**Fix:** Make the status check configurable based on the operation being performed.

---

### 15. No Cleanup of Expired Pending Entries
**Location:** `commands/story.js` - `handleWriteModalSubmit()` function

**Problem:** When a quick mode entry is created with status 'pending' and a timeout, there's no automated job or process that cleans up expired entries. The timeout is mentioned in the message but not enforced.

**Impact:** Database accumulates pending entries that were never confirmed or discarded. No automatic consequence when the timeout expires.

**Fix:** Create a scheduled job (using the `job` table) to check for and clean up expired pending entries, potentially auto-discarding them or notifying the writer.

---

### 16. Race Condition in Join Eligibility
**Location:** `commands/story.js` - `handleJoinModalSubmit()` function (line ~560)

**Problem:** The code re-validates join eligibility after showing the modal, but between the validation and the actual join, another user might join and fill the story to capacity.

**Impact:** Two users could potentially join at the same time and exceed `max_writers` limit.

**Fix:** Perform the validation within the transaction when actually inserting the writer record, not before.

---

### 17. Guild ID Undefined in Error Cases
**Location:** Multiple locations in `storybot.js`

**Problem:** Functions like `checkStoryDelay()` reference `story.guild_id` in error logging, but if the story query fails, `story` is undefined and this causes a secondary error.

**Impact:** Error messages crash instead of logging properly, hiding the original error.

**Fix:** Use optional chaining: `story?.guild_id || 'unknown'`

---

## Low Priority Issues (Best Practices)

### 18. Inconsistent Error Handling Patterns
**Location:** Throughout the codebase

**Problem:** Some functions return `{ success: false, error: 'message' }` objects, others throw exceptions, and others return failed promises. This makes it difficult to know how to handle errors consistently.

**Impact:** Some errors might not be caught or handled appropriately by calling code.

**Fix:** Standardize on one error handling pattern throughout the application.

---

### 19. Hardcoded English Text
**Location:** Multiple locations

**Problem:** Some error messages and logs use hardcoded English text instead of pulling from config. Examples: "Writer not found", "No active turn found", "Entry not found".

**Impact:** These messages won't be translated when using different language configurations.

**Fix:** Move all user-facing text to config values.

---

### 20. No Input Length Validation
**Location:** `commands/story.js` - modal handlers

**Problem:** While maxLength is set on text inputs, there's no server-side validation that the received data actually respects these limits before inserting into database.

**Impact:** If Discord's validation fails or is bypassed, database could receive text that exceeds column limits.

**Fix:** Add explicit validation after receiving modal input before database insertion.

---

## Summary

**Critical Issues:** 4 (will prevent bot from working)
**High Priority:** 6 (will cause significant malfunctions)  
**Medium Priority:** 9 (may cause problems in specific scenarios)
**Low Priority:** 3 (best practices and maintainability)

**Total Issues Found:** 22

### Recommended Fix Order:
1. Fix database schema table creation order (#1)
2. Fix getConfigValue connection issue (#2)
3. Fix transaction management (#4)
4. Add missing writer_order column (#3)
5. Fix incomplete turn advancement (#7)
6. Fix content/botContent typo (#5)
7. Remove thread permission overwrites (#8)
8. Address remaining high/medium priority issues

The bot currently cannot start due to issues #1 and #2. Once those are fixed, it will start but won't work properly due to issues #3-#8.
