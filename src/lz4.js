/* Tiny LZ4 block codec (decode & encode) – enough for PlayCanvas
  * compressed-PLY files.  No streaming frames, no checksums.
  *
  * Public API:
  *   export function decompress(srcU8)  ->  Uint8Array
  *   export function compress  (srcU8)  ->  Uint8Array */

export function decompress(src) {
    const dst = new Uint8Array(src.length * 4);   // worst-case
    let sp = 0, dp = 0;
    while (sp < src.length) {
        const token = src[sp++];
        let litLen = token >> 4;
        if (litLen === 0x0f) while (src[sp] === 0xff) litLen += 0xff, sp++;
        dst.set(src.subarray(sp, sp + litLen), dp); dp += litLen; sp += litLen;
        if (sp >= src.length) break;

        const back  = src[sp] | (src[sp + 1] << 8); sp += 2;
        let matchLen = (token & 0x0f) + 4;
        if ((token & 0x0f) === 0x0f) while (src[sp] === 0xff) matchLen += 0xff, sp++;

        for (let i = 0; i < matchLen; i++) {
            dst[dp] = dst[dp - back]; dp++;
        }
    }
    return dst.subarray(0, dp);
}

export function compress(src) {
    /* Tiny encoder: not optimal but < 1 KB.  Good enough for once-per-tile. */
    const dst = [];
    const hash = new Uint32Array(1 << 16).fill(0);
    const HASH = (v) => ((v * 2654435761) >>> 16) & 0xffff;

    let ip = 0, anchor = 0;
    const emit = (litLen, mOff, mLen) => {
        let token = Math.min(litLen, 0x0f) << 4;
        let out = [];
        if (litLen >= 0x0f) { let v = litLen - 0x0f; while (v >= 0xff) out.push(0xff), v -= 0xff; out.push(v); }
        out.push(...src.subarray(anchor, anchor + litLen));
        if (mOff !== undefined) {
            token |= Math.min(mLen - 4, 0x0f);
            out.push(mOff & 0xff, mOff >> 8);
            if (mLen - 4 >= 0x0f) { let v = mLen - 4 - 0x0f; while (v >= 0xff) out.push(0xff), v -= 0xff; out.push(v); }
        }
        dst.push(token, ...out);
    };

    while (ip < src.length - 4) {
        const h = HASH(src[ip] | (src[ip + 1] << 8) | (src[ip + 2] << 16) | (src[ip + 3] << 24));
        const ref = hash[h]; hash[h] = ip;
        if (ref && ip - ref < 0xffff &&
            src[ref] === src[ip] && src[ref + 1] === src[ip + 1] && src[ref + 2] === src[ip + 2]) {
            let lit = ip - anchor;
            let match = 4; while (ip + match < src.length && src[ref + match] === src[ip + match]) match++;
            emit(lit, ip - ref, match);
            ip += match; anchor = ip; continue;
        }
        ip++;
    }
    emit(src.length - anchor);
    return Uint8Array.from(dst);
}
