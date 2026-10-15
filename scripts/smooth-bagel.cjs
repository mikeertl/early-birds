// Preserve the supplied GIF's frames/palette; remove its two held frames.
// The original is kept so this timing-only edit is reproducible and reversible.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../assets');
const original = path.join(root, 'bagel-original.gif');
if (!fs.existsSync(original)) fs.copyFileSync(path.join(root, 'bagel.gif'), original);
const bytes = fs.readFileSync(original);
if (bytes.subarray(0, 6).toString() !== 'GIF89a') throw Error('Expected the supplied GIF89a animation');
let position = 13;
if (bytes[10] & 128) position += 3 * 2 ** ((bytes[10] & 7) + 1);
const output = [bytes.subarray(0, position)], frames = [];
let control;
function skipBlocks() {
  while (bytes[position]) {
    position += bytes[position] + 1;
    if (position >= bytes.length) throw Error('Invalid GIF sub-block');
  }
  position++;
}
while (position < bytes.length) {
  const start = position, type = bytes[position++];
  if (type === 0x3b) break;
  if (type === 0x21) {
    const label = bytes[position++]; skipBlocks();
    const extension = bytes.subarray(start, position);
    if (label === 0xf9) control = extension;
    else output.push(extension);
  } else if (type === 0x2c) {
    const packed = bytes[position + 8]; position += 9;
    if (packed & 128) position += 3 * 2 ** ((packed & 7) + 1);
    position++; skipBlocks();
    if (!control) throw Error('Missing frame timing');
    frames.push(Buffer.concat([control, bytes.subarray(start, position)])); control = null;
  } else throw Error('Unexpected GIF block');
}
if (frames.length !== 22) throw Error('The supplied animation has changed; review its held frames first');
// Decoded comparison: frame 15 repeats 14 exactly; 16 differs only in a few
// background pixels. Keeping both adds a visible 0.2-second hold in each cycle.
frames.forEach((frame, index) => { if (index !== 15 && index !== 16) output.push(frame); });
output.push(Buffer.from([0x3b]));
fs.writeFileSync(path.join(root, 'bagel.gif'), Buffer.concat(output));
console.log('Removed two held frames; 20 moving frames, 2 seconds, original infinite-loop setting retained.');
