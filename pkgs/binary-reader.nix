{
  lib,
  buildPythonPackage,
  fetchPypi,
  setuptools,
}:

buildPythonPackage rec {
  pname = "binary-reader";
  version = "1.4.3";
  pyproject = true;

  src = fetchPypi {
    # sdist is published as binary_reader-<version>.tar.gz (underscore)
    pname = "binary_reader";
    inherit version;
    hash = "sha256-IT1RTP94BUI/JAu8t0t4JacqKW60+75jJKbuRvsHMh0=";
  };

  build-system = [ setuptools ];

  # No runtime dependencies.
  pythonImportsCheck = [ "binary_reader" ];

  meta = {
    description = "Boilerplate-free reader and writer for binary data";
    homepage = "https://github.com/SutandoTsukai181/PyBinaryReader";
    license = lib.licenses.mit;
    maintainers = with lib.maintainers; [ ];
  };
}
