{
  lib,
  buildPythonPackage,
  fetchPypi,
  setuptools,
  bottle,
  gevent-websocket,
}:

buildPythonPackage rec {
  pname = "bottle-websocket";
  version = "0.2.9";
  pyproject = true;

  src = fetchPypi {
    inherit pname version;
    hash = "sha256-mIf3DcDHWS7Y0NEaFKqV3t5s0I1Q2D1bgf2WPl/sc4s=";
  };

  build-system = [ setuptools ];

  dependencies = [
    bottle
    gevent-websocket
  ];

  pythonImportsCheck = [ "bottle_websocket" ];

  meta = {
    description = "WebSocket plugin for the Bottle web framework, backed by gevent-websocket";
    homepage = "https://github.com/zeekay/bottle-websocket";
    license = lib.licenses.mit;
    maintainers = with lib.maintainers; [ ];
  };
}
