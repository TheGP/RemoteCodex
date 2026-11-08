For macOS builds and updates, use `npm run package:mac` and `npm run install:mac`.
Use the fixed `dist/Remote Codex-darwin-x64` output; never create per-feature build or backup folders.
The installer keeps one compressed rollback archive and protects files used by running apps.
Use `npm run cleanup:mac` to remove old app backups after restarting.
Never restart or kill the user's running app to install an update.
