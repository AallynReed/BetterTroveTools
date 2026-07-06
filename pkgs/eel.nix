{
  lib,
  buildPythonPackage,
  fetchPypi,
  setuptools,
  bottle,
  bottle-websocket,
  pyparsing,
  typing-extensions,
  importlib-resources,
  gevent,
}:

buildPythonPackage rec {
  pname = "eel";
  version = "0.18.2";
  pyproject = true;

  src = fetchPypi {
    inherit pname version;
    hash = "sha256-D3Cw+KotpXhZs11Ejqia0hAtVrIG+FAPEw3waenfLDo=";
  };

  build-system = [ setuptools ];

  # `future` is a Py2/3 compat shim eel still declares but doesn't need on
  # modern Python; it's also unsupported on python3.13 in nixpkgs.
  pythonRemoveDeps = [ "future" ];

  dependencies = [
    bottle
    bottle-websocket
    pyparsing
    typing-extensions
    importlib-resources
    gevent
  ];

  pythonImportsCheck = [ "eel" ];

  meta = {
    description = "Little Python library for making simple Electron-like offline HTML/JS GUI apps";
    homepage = "https://github.com/python-eel/Eel";
    license = lib.licenses.mit;
    maintainers = with lib.maintainers; [ ];
  };
}
