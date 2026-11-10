const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('completion chime has audible headroom, a short duration, and a quiet ending', () => {
  const wav = fs.readFileSync(path.join(__dirname, '../assets/completion.wav'));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  const duration = (wav.length - 44) / 2 / wav.readUInt32LE(24);
  assert.ok(duration >= 0.35 && duration <= 0.7);
  let peak = 0, energy = 0, samples = 0;
  for (let offset = 44; offset < wav.length; offset += 2) {
    const value = wav.readInt16LE(offset) / 32768;
    peak = Math.max(peak, Math.abs(value)); energy += value * value; samples++;
  }
  assert.ok(peak >= 0.6 && peak <= 0.8, 'Chime is too quiet or has insufficient headroom');
  assert.ok(Math.sqrt(energy / samples) >= 0.1);
  assert.ok(Math.abs(wav.readInt16LE(wav.length - 2) / 32768) < 0.01);
});
