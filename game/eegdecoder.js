// In-browser EEG decoder (web edition): the same CSP + log-power + LDA + softmax math as
// sim/decoder.py, run on the real held-out PhysioNet epochs shipped in eeg/epochs.bin.
export class BrowserDecoder {
  async load(base = "eeg/") {
    const [meta, buf] = await Promise.all([
      fetch(base + "decoders.json").then((r) => r.json()),
      fetch(base + "epochs.bin").then((r) => r.arrayBuffer()),
    ]);
    this.meta = meta;
    this.data = new Int16Array(buf);
    return this;
  }
  has(id) { return !!this.meta?.trials[id]; }
  decode(id) {
    const t0 = performance.now();
    const tr = this.meta.trials[id], m = this.meta.models[tr.model];
    const [nch, nt] = m.shape, W = m.W, k = W.length;
    const x = this.data.subarray(tr.offset, tr.offset + nch * nt), s = tr.scale;
    const f = new Float64Array(k);
    for (let c = 0; c < k; c++) {            // CSP filter -> mean power -> log
      const w = W[c];
      let acc = 0;
      for (let t = 0; t < nt; t++) {
        let z = 0;
        for (let ch = 0; ch < nch; ch++) z += w[ch] * x[ch * nt + t] * s;
        acc += z * z;
      }
      f[c] = Math.log(acc / nt);
    }
    const d = m.coef.map((row, j) => row.reduce((a, v, i) => a + v * f[i], m.intercept[j])); // LDA
    const mx = Math.max(...d), e = d.map((v) => Math.exp(v - mx)), sum = e.reduce((a, b) => a + b, 0);
    const p = e.map((v) => v / sum);                                                          // softmax
    const best = p.indexOf(Math.max(...p)), C = this.meta.classes;
    return {
      trial: id, model: tr.model, command: C[best], conf: Math.round(p[best] * 1000) / 1000,
      proba: Object.fromEntries(C.map((c, i) => [c, Math.round(p[i] * 1000) / 1000])),
      samples: [nch, nt], ms: Math.round((performance.now() - t0) * 1000) / 1000,
    };
  }
}
