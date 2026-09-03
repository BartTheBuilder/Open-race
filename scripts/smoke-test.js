// Loads the real app.js under gjs (SpiderMonkey) against the DOM/Leaflet
// stub in dom-stub.js, and reports whether top-level script execution threw.
// This is a load smoke test, not a behavior test - see dom-stub.js for what
// it does and doesn't cover. Run via scripts/check.sh.
const { GLib } = imports.gi;

function readFile(path) {
  const [ok, contents] = GLib.file_get_contents(path);
  if (!ok) throw new Error(`could not read ${path}`);
  return imports.byteArray.toString(contents);
}

const repoDir = GLib.path_get_dirname(GLib.path_get_dirname(ARGV[0] || '.'));
const stubSrc = readFile(`${repoDir}/scripts/dom-stub.js`);
const appSrc = readFile(`${repoDir}/app.js`);

try {
  eval(stubSrc);
  eval(appSrc);
  print('SMOKE TEST: OK - app.js executed top-to-bottom without throwing');
} catch (e) {
  print('SMOKE TEST: FAILED');
  print(String(e));
  if (e.stack) print(e.stack);
  imports.system.exit(1);
}
