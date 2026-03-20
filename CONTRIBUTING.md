# Contributing

## Project Overview

This Discord bot manages collaborative round-robin story writing events with the following features:

- **Multi-story support**: Run multiple stories simultaneously on a server
- **User participation**: Users can join multiple stories, defining unique pen name and status for each
- **Turn management**: Writers are chosen in random order, admin can manually define next writer chosen 
- **Flexible timing**: Stories can have custom turn lengths and reminder settings
- **Story modes**: Support for both quick mode and normal mode storytelling
- **Story states**: Stories can be active, paused, or closed
- **Admin controls**: Admins can manage user and story settings
- **Timeout tracking**: System tracks user timeouts and manual passing
- **Entry system**: Writers can submit multiple entries per turn from the private thread that is opened when their turn starts. Media entries are forwarded to a media channel and the post id of the forwarded message is stored. Entries within a turn are kept in order posted.
- **Publishing integration**: Closed stories can be exported to PDF and posted to AO3
- **Job scheduling**: Background job system for reminders and turn timeouts

## Development Guidelines

### Code Organization
- Keep Discord client logic in `index.js`
- Keep story engine logic in `storybot.js` with event emission to index.js
- Shared utilities go in `utilities.js`
- Command handlers in separate files under `commands/` directory
- Database schema changes use numbered migration files

### Naming Conventions
- Function names and parameters use camelCase + ID: guildID, storyID, userID, etc.
- Database fields and tables use snake_case: guild_id, story_id, user_id, etc.
- Local variables from Discord objects use camelCase + Id: guildId, userId, channelId

### Configuration Management
- Use `getConfigValue(key, guildID)` for all user-facing text and configuration variables
- getConfigValue supports multi-language configuration by retrieving a guild-specific language_code
- User-facing text is stored as `txtFieldName`, form labels are `lblFieldName`, and configuration variables are `cfgFieldName`. 
- Variables in template text that must be replaced with contextual values use bracket notation: `[story_id]`and use `replaceTemplateVariables()` for processing, passing a valueKeyMap with contextual data.

### Error Handling Standards
- Error messages should be sent to the console beginning with: `${formattedDate()}: ` + Error description
- Include function name in error message: `FunctionName failed:` or `Error in FunctionName:`
- Include key parameters for debugging context where helpful (e.g., IDs, user input)
- Return structured objects with `success` boolean and `error`/`message` fields
- Use database transactions for multi-step operations with rollback on errors

### Database Interaction Guidelines
- Use prepared sql statements with parameter binding
- Use explicit transactions for operations affecting multiple tables
- Release connections in `finally` blocks to prevent connection leaks
- Follow the pattern: `await connection.beginTransaction()` → operations → `await connection.commit()` → `connection.release()`

### Discord API Best Practices  
- Use `interaction.deferReply()` for operations that may take longer than 3 seconds
- Handle modal submissions with two-stage validation (client-side + server-side)
- Include reason parameters where applicable for audit log clarity

