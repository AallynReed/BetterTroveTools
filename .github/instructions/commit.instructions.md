# Git Commit Message Standards
When generating commit messages, you must use the following prefix system. Analyze the staged changes and select the most appropriate prefix from the list below:

## Allowed Prefixes
- **fix**: Use when the code fixes a bug or an existing problem.
- **change**: Use when the code alters the existing behavior of a feature.
- **feat**: Use when adding entirely new functionality.
- **refactor**: Use for code changes that neither fix a bug nor add a feature, but improve the internal structure or logic.
- **style**: Use for changes to the user interface or visual appearance that do not affect underlying functionality.
- **chore**: Use for maintenance tasks. 

## Special Rules for 'chore'
When the 'chore' prefix is selected, use a simplified message format:
- For localization updates: `chore: update localization files`
- For version updates: `chore: upgrade to version X.X.X` (replace X.X.X with the version found in the diff).

## Localization Updates
When the commit includes changes to localization files, ensure that the message clearly indicates the nature of the update, keep it simple, and avoid unnecessary details. For example:
- `chore: update localization files`
Always use the 'chore' prefix for localization updates, and do not include specific details about the changes in the commit message.
Localization files typically are named with a pattern like `*.json` with the name being a locale code (e.g., `en_US.json`, `fr_FR.json`).

## Version Updates
When the commit includes changes to version numbers, ensure that the message clearly indicates the version update, keep it simple, and avoid unnecessary details. For example:
- `chore: upgrade to version X.X.X` (replace X.X.X with the version found in the diff).
Always use the 'chore' prefix for version updates, and do not include specific details about the changes in the commit message.

## General Formatting
- Use the imperative mood (e.g., "fix" instead of "fixed").
- Keep the summary line concise.
- If the change is complex, provide a brief bulleted list in the message body explaining the "why" behind the change.