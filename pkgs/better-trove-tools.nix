{
  lib,
  stdenv,
  src,
  python3,
  wrapGAppsHook3,
  gobject-introspection,
  gtk3,
  webkitgtk_4_1,
  libsoup_3,
  glib-networking,
  gst_all_1,
  copyDesktopItems,
  makeDesktopItem,
}:

# Better Trove Tools is a "run-from-source" Python desktop app: there is no
# setup.py / pyproject.toml, so we don't build a wheel. We stage the source
# tree into $out/share and wrap a launcher that runs main.py with a Python
# interpreter carrying all runtime deps. The Windows-only bits (cx-Freeze MSI,
# pythonnet self-updater, registry auto-detect) are inert on Linux.

let
  python = python3;

  # WebKitGTK renders media through GStreamer; without these on
  # GST_PLUGIN_SYSTEM_PATH_1_0 it warns "element appsink not found" and audio/
  # video in the webview stays silent. base carries appsink + core codecs,
  # good/bad/libav cover the common web formats (mp4/h264, webm, mp3, ...).
  gstPlugins = with gst_all_1; [
    gstreamer
    gst-plugins-base
    gst-plugins-good
    gst-plugins-bad
    gst-libav
  ];

  pythonEnv = python.withPackages (
    ps: with ps; [
      binary-reader
      eel

      aiofiles
      bottle
      gevent
      pydantic
      pywebview
      requests
      toml
      vdf
      pygobject3
      tkinter
    ]
  );
in
stdenv.mkDerivation (finalAttrs: {
  pname = "better-trove-tools";
  # Read straight from metadata.json (bumped as step 1 of every release), so the
  # Nix version never drifts and there's no separate string to hand-maintain.
  version = (lib.importJSON ../metadata.json).APP_VERSION;

  inherit src;

  nativeBuildInputs = [
    wrapGAppsHook3
    gobject-introspection
    copyDesktopItems
  ];

  buildInputs = [
    gtk3
    webkitgtk_4_1
    libsoup_3
    glib-networking
  ]
  ++ gstPlugins;

  dontConfigure = true;
  dontBuild = true;

  dontWrapGApps = true;

  installPhase = ''
    runHook preInstall

    appdir="$out/share/better-trove-tools"
    mkdir -p "$appdir"
    cp -r . "$appdir/"
    # Drop build/CI/dev-only bits the Linux app never touches.
    rm -rf "$appdir"/{.git,.github,android,compile.py,capacitor.config.json} \
           "$appdir"/{package.json,package-lock.json,requirements*.txt,web-requirements.txt} \
           "$appdir"/{install-linux.sh,run.sh} \
           "$appdir"/{flake.nix,flake.lock,pkgs}

    # The app hardcodes web/favicon.ico as its pywebview window icon, but it's a
    # PNG-compressed .ico that gdk-pixbuf refuses ("Compressed icons are not
    # supported"), aborting window creation. GdkPixbuf sniffs format by content,
    # not extension, so drop the plain PNG in under the same filename.
    cp assets/icon.png "$appdir/web/favicon.ico"

    makeWrapper ${pythonEnv}/bin/python $out/bin/better-trove-tools \
      "''${gappsWrapperArgs[@]}" \
      --prefix GI_TYPELIB_PATH : "$GI_TYPELIB_PATH" \
      --prefix GST_PLUGIN_SYSTEM_PATH_1_0 : "${lib.makeSearchPath "lib/gstreamer-1.0" gstPlugins}" \
      --set-default PYWEBVIEW_GUI gtk \
      --set-default GDK_BACKEND x11 \
      --add-flags "$appdir/main.py" \
      --chdir "$appdir"

    install -Dm644 assets/icon.png \
      "$out/share/icons/hicolor/256x256/apps/better-trove-tools.png"

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "better-trove-tools";
      desktopName = "Better Trove Tools";
      comment = "Desktop companion for Trove players, collectors, and modders";
      exec = "better-trove-tools";
      icon = "better-trove-tools";
      categories = [
        "Game"
        "Utility"
      ];
      startupWMClass = "Better Trove Tools";
    })
  ];

  meta = {
    description = "Offline-capable suite of utilities for players and modders of the game Trove";
    homepage = "https://github.com/AallynReed/BetterTroveTools";
    changelog = "https://github.com/AallynReed/BetterTroveTools/releases/tag/${finalAttrs.version}";
    license = lib.licenses.mit;
    mainProgram = "better-trove-tools";
    platforms = lib.platforms.linux;
    maintainers = with lib.maintainers; [ ];
  };
})
