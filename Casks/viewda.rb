cask "viewda" do
  arch arm: "arm64", intel: "x64"

  version "0.3.0"
  sha256 arm:   "ffc4482f68e0e4c0a4cb0a9691b484c7c163909aeac44198881ad9a4828edb92",
         intel: "a9cc13d14391ea466802bd973a7690da3d7c8fc136f320c1b858a6ef565f4803"

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
