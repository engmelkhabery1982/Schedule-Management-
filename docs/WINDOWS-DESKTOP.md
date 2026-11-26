# Schedule Management on Windows

The Tauri desktop shell bundles the existing Schedule Management UI. Launch it
from the Windows Start menu after installing the per-user NSIS setup. The
installed executable uses WebView2 and does not require Node.js or a local server.

## Existing workspace

The desktop application has a separate WebView2 storage origin from the browser
pilot. On first launch it may show an empty workspace. To move projects, export
a backup from the original browser profile and address, then use the built-in
restore in the desktop app. See [First use and backup](FIRST-USE-AND-BACKUP.md).
Keep the original backup. The Windows shell adds no migration and keeps the
existing local workspace format and backup validation.

## Building

Install Node, the Rust MSVC toolchain, Windows build tools, and Tauri CLI v2.
Run `npm ci`, then `cargo tauri build --bundles nsis` from the project root
when the Cargo Tauri CLI is installed. Use a build environment without
`VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` for the standalone local
workspace. The installer is under `src-tauri/target/release/bundle/nsis/`.
