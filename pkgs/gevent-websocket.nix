{
  lib,
  buildPythonPackage,
  fetchPypi,
  setuptools,
  gevent,
}:

buildPythonPackage rec {
  pname = "gevent-websocket";
  version = "0.10.1";
  pyproject = true;

  src = fetchPypi {
    inherit pname version;
    hash = "sha256-fq7zKWgpDJEh98Nblz4swwL/sHbQGMkGjS9cqLLYX7A=";
  };

  build-system = [ setuptools ];

  dependencies = [ gevent ];

  pythonImportsCheck = [ "geventwebsocket" ];

  meta = {
    description = "WebSocket handler for the gevent pywsgi server, a Python network library";
    homepage = "https://gitlab.com/noppo/gevent-websocket";
    # Upstream ships an Apache-2.0 LICENSE; confirm before submitting.
    license = lib.licenses.asl20;
    maintainers = with lib.maintainers; [ ];
  };
}
