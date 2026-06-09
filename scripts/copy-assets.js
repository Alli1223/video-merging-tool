'use strict';

// Copy the renderer's static assets (HTML/CSS) and the app icons into the
// compiled output directory. The compiled main process resolves these relative
// to __dirname (= out/ after the TypeScript build), so they must sit next to
// the emitted JS for both `npm start` and the packaged build to find them.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'out');

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log('copied', path.relative(root, from), '->', path.relative(root, to));
}

copyFile(path.join(root, 'renderer', 'index.html'), path.join(out, 'renderer', 'index.html'));
copyFile(path.join(root, 'renderer', 'styles.css'), path.join(out, 'renderer', 'styles.css'));

const assetsSrc = path.join(root, 'assets');
if (fs.existsSync(assetsSrc)) {
  fs.cpSync(assetsSrc, path.join(out, 'assets'), { recursive: true });
  console.log('copied assets/ -> out/assets/');
}
