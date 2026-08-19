cask "viewda" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0"
  sha256 arm:   "b93ef5701abd02743ecca951220d39fe76b66c3b7cdf6db6d31e2d4b2b5b6fad",
         intel: "92c2a57666e7c2c12a27ab285879c3dad1bccbf4e2e3d63f0eeacd29738b9e63"

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
