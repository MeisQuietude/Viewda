cask "viewda" do
  arch arm: "arm64", intel: "x64"

  version "0.2.0"
  sha256 arm:   "55cca4a65b3e62cffc7ab3a445f6d56987ac5c0409f27be7a3a73e6cb8d958d4",
         intel: "16c9f9c63ba869a327af907f948bdec0d4c664336dbf3bcff33afe03e5a676f4"

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
