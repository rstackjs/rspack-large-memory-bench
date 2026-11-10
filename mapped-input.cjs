// A neutral transform with an identity map at token boundaries. The following
// SWC loader must compose this input map with its own output map.
const path = require('node:path');
const alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function vlq(value) {
  let n = Math.abs(value) * 2 + Number(value < 0);
  let out = '';
  do {
    const bits = n % 32;
    n = Math.floor(n / 32);
    out += alphabet[bits + (n ? 32 : 0)];
  } while (n);
  return out;
}
module.exports = function mappedInput(source) {
  let previousLine = 0;
  let previousColumn = 0;
  const mappings = source
    .split('\n')
    .map((line, i) => {
      let generatedColumn = 0;
      const segments = [];
      for (const match of line.matchAll(/\S+/g)) {
        const col = match.index;
        segments.push(
          vlq(col - generatedColumn) +
            'A' +
            vlq(i - previousLine) +
            vlq(col - previousColumn),
        );
        generatedColumn = previousColumn = col;
        previousLine = i;
      }
      return segments.join(',');
    })
    .join(';');
  this.callback(null, source, {
    version: 3,
    sources: [path.basename(this.resourcePath)],
    names: [],
    mappings,
    sourcesContent: [source],
  });
};
