# LiConfig Code OSS fork

This repository owns the Code OSS source used by the standalone LiConfig editor.
The release customizations were consolidated from the formerly unversioned
`Tools/LiConfig/ThirdParty/CodeOSS` build copy on 2026-09-24.

## Retained release behavior

- LiConfig application identity, desktop/server/installer icons and workbench artwork.
- XLSX/CSV location navigation, projected workbook resources, editor columns and reference navigation.
- Diagnostic location labels, independent compilation-results windows and persisted native window bounds.
- Eager custom-editor registration and first-launch workbook resolution.
- The existing LiConfig default for workspace trust; users can enable trust in settings.
- Windows dependency packaging: target-specific native payloads, Copilot SDK materialization and unsigned builds without signtool.

The obsolete ConfigStudio/CSVX bridge is replaced by the actual LiConfig release implementation.
Tests cover the current XLSX bridge. Local profiles and build caches are not source files.
The npm-generated untracked fixture lockfiles and npm-version-only lockfile churn are excluded.

## Build and product ownership

Use Node from `.nvmrc`, npm < 12, Python, Visual Studio C++ build tools and the Windows SDK.
Run `npm ci` to restore this repository's locked dependency graph (including its postinstall steps).
Run `npm run typecheck-client` and `npm --prefix build run typecheck` before packaging.
The distribution task is `npm run gulp vscode-win32-x64-min`.

The matching engine repository contains `Tools/LiConfig`, the product assets,
TypeScript adapters, C# host/CLI and extension. Its
`Scripts/Restore-LiConfigCodeOSS.ps1`, `Build-LiConfig.ps1 -Package` and
`Publish-LiConfig.ps1 -Destination <new-directory>` restore, build and publish the complete application.
Code OSS alone does not contain the LiConfig extension or C# runtime.

The engine repository records the upstream base, a binary source patch and hashes in
`Tools/LiConfig/CodeOSS`. This makes the source reproducible before the fork commit is
pushed and avoids any dependency on a developer's D: drive. That patch is the complete
release delta; the older `Scripts/Patches` files are historical and are not reapplied.

Brand artwork is authored in `Tools/LiConfig/Resources/Branding` and product identity in
`Scripts/LiConfig.product.json`. `Configure-LiConfig-CodeOSS.cjs` applies them to the
restored build copy and the packaged executable. Keep upstream licenses and notices.
