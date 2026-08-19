cask "viewda" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0-alpha.3"
  sha256 arm:   "64ab873d8a3a35d8209b8618528b01732ffa3b5b6654a9225e03b73cfdd8f245",
         intel: "2192b3c9a0a8376fc5a1d7a31588f3c58b261fe985d057dabdb4d5e2ea86e3f5"

  url "https://github.com/MeisQuietude/Viewda/releases/download/v#{version}/Viewda_#{version}_#{arch}.dmg"
  name "Viewda"
  desc "Free, fully offline Apache Parquet viewer"
  homepage "https://github.com/MeisQuietude/Viewda"

  # The app updates itself through its built-in update check; `brew upgrade`
  # leaves it alone unless invoked with `--greedy`.
  auto_updates true

  app "Viewda.app"

  # The app itself persists only under Application Support (recents,
  # settings, update state); the rest is WKWebView and AppKit residue.
  zap trash: [
    "~/Library/Application Support/io.github.meisquietude.viewda",
    "~/Library/Caches/io.github.meisquietude.viewda",
    "~/Library/HTTPStorages/io.github.meisquietude.viewda",
    "~/Library/Preferences/io.github.meisquietude.viewda.plist",
    "~/Library/Saved Application State/io.github.meisquietude.viewda.savedState",
    "~/Library/WebKit/io.github.meisquietude.viewda",
  ]

  caveats <<~EOS
    Viewda prereleases are ad hoc signed, not notarized. If macOS blocks the
    first launch, choose System Settings → Privacy & Security → Open Anyway.
  EOS
end
