{
  lib,
  src,
  rustPlatform,
  cargo-tauri,
  pkg-config,
  wrapGAppsHook3,
  openssl,
  glib-networking,
  webkitgtk_4_1,
  libayatana-appindicator,
  librsvg,
  gst_all_1,
}:

let
  # metadata.json's YYYY.MM.XX[a|b]: Tauri wants semver, so 2026.10.07b -> 2026.10.7-beta.
  appVersion = (lib.importJSON ../metadata.json).APP_VERSION;
  parts = builtins.match "([0-9]+)\\.([0-9]+)\\.([0-9]+)([ab]?)" appVersion;
  stage = { "" = ""; a = "-alpha"; b = "-beta"; }.${builtins.elemAt parts 3};
  num = i: toString (lib.toIntBase10 (builtins.elemAt parts i));
  semver = "${num 0}.${num 1}.${num 2}${stage}";

  # WebKitGTK plays media through GStreamer.
  gstPlugins = with gst_all_1; [
    gstreamer
    gst-plugins-base
    gst-plugins-good
    gst-plugins-bad
    gst-libav
  ];
in
rustPlatform.buildRustPackage (finalAttrs: {
  pname = "better-trove-tools";
  version = appVersion;

  inherit src;
  cargoLock.lockFile = ../Cargo.lock;

  nativeBuildInputs = [
    cargo-tauri.hook
    pkg-config
    wrapGAppsHook3
  ];

  buildInputs = [
    openssl
    glib-networking
    webkitgtk_4_1
    libayatana-appindicator
    librsvg
  ]
  ++ gstPlugins;

  buildAndTestSubdir = "src-tauri";
  tauriBuildFlags = [
    "--config"
    (builtins.toJSON { version = semver; })
  ];

  # btt-core's tests run in CI; several need a Trove install or the network.
  doCheck = false;

  preFixup = ''
    gappsWrapperArgs+=(
      --prefix LD_LIBRARY_PATH : "${lib.makeLibraryPath [ libayatana-appindicator ]}"
      --prefix GST_PLUGIN_SYSTEM_PATH_1_0 : "${lib.makeSearchPath "lib/gstreamer-1.0" gstPlugins}"
    )
  '';

  meta = {
    description = "Offline-capable suite of utilities for players and modders of the game Trove";
    homepage = "https://github.com/AallynReed/BetterTroveTools";
    changelog = "https://github.com/AallynReed/BetterTroveTools/releases/tag/${finalAttrs.version}";
    license = lib.licenses.mit;
    mainProgram = "BetterTroveTools";
    platforms = lib.platforms.linux;
    maintainers = with lib.maintainers; [ ];
  };
})
