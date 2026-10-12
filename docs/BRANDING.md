# SendIt! branding

The display name is **SendIt!**. Package names, data folders and release filenames use `sendit` or `SendIt` so they remain convenient for command-line use.

The logo was generated with the built-in imagegen tool. The original transparent PNG is `assets/logo.png`. `scripts/icon.ps1` derives `assets/icon.png` and a Windows ICO with 16, 24, 32, 48, 64, 128 and 256 pixel sizes. The app header, startup screen, desktop window and portable executable use this artwork. `assets/icon.svg` is a raster-backed SVG wrapper.

## Generation prompt

> Use case: logo-brand. Create a polished original app icon for SendIt!, a desktop API client for sending and testing requests. A bold white paper plane / forward send arrow integrated with a subtle S-shaped negative space, on a rich blue rounded-square tile. Crisp flat geometric design, confident and minimal, readable at 16px. Centered tile nearly fills square canvas with 6% transparent padding. No letters, no words, no watermark, no mockup, no extra objects. Transparent background outside rounded tile.

Compatibility references to the former app name remain in data-directory detection, default-title migration, backup import and secret-variable import. New data and exports use SendIt naming.
