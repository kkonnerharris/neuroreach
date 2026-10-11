// node tests/test_web_decoder.mjs: the browser decoder must agree with the library on every trial
import fs from "node:fs";
import { BrowserDecoder } from "../game/eegdecoder.js";
const dec = new BrowserDecoder();
dec.meta = JSON.parse(fs.readFileSync("web/eeg/decoders.json", "utf8"));
const b = fs.readFileSync("web/eeg/epochs.bin");
dec.data = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
const deck = JSON.parse(fs.readFileSync("game/eeg-deck.js", "utf8").trim().replace(/^window\.EEG_DECK = /, "").replace(/;$/, ""));
let n = 0, same = 0, maxd = 0;
for (const s of deck.subjects) for (const c of s.cards) {
  const r = dec.decode(c.id); n++;
  if (r.command === c.pred) same++;
  maxd = Math.max(maxd, Math.abs(r.conf - c.conf));
}
console.log(`${same}/${n} same command, max confidence diff ${maxd.toFixed(4)}`);
process.exit(same === n ? 0 : 1);
