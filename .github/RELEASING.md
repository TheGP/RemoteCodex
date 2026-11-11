# Releases

Every push to `master` runs the release workflow. You can also run **Actions → Release → Run workflow** on `master`.

The first version is **0.1.0**. Later releases increase only the patch: **0.1.1**, **0.1.2**, …, **0.1.10**. Commit message types never increase the major or minor version. Rerunning the same tagged commit reuses its version, and an already published release stays unchanged.

The workflow runs unit tests and the Electron UI suite, then builds:

- macOS Intel (`macos-x64.zip`)
- macOS Apple Silicon (`macos-arm64.zip`)
- Windows Intel/AMD 64-bit (`windows-x64.zip`)

The release appears only after all builds succeed. Downloads include `SHA256SUMS.txt` and generated release notes. Intermediate Actions artifacts expire after one day.

On macOS, extract the ZIP and move **Remote Codex.app** into Applications. These builds are unsigned and not notarized. On Windows, extract the entire ZIP and run **Remote Codex.exe** from inside its folder; keep the accompanying files together.

Git tags record the released version. `package.json` sets the starting version for the series; each build stamps its computed version into the packaged app without adding automated commits to `master`. Changing the major/minor series requires an explicit source change.

The workflow uses GitHub's built-in token with release-writing permission only in the publish job. No additional secret is needed. This publishes downloads; it does not install updates into running apps.
