
'use strict';

// Load renderer as a *Node module* so all relative requires inside it resolve
// relative to lib/renderer.js (NOT relative to index.html in app.asar).
require('./lib/renderer.js');
