import { decompress, compress } from './lz4.js';

/** Runtime octree tiler – splits a compressed-PLY into compressed leaves.
 *  @param {string} url         URL of the .splat.compressed.ply
 *  @param {number} leafPoints  Max points per leaf
 *  @returns {Promise<Array<{buffer:Uint8Array, bbox:{min,max}}>>} */


export async function chunkCompressedPly(url, leafPoints = 40000) {
    const rawFile = await fetch(url).then(r => r.arrayBuffer());
    const u8 = new Uint8Array(rawFile);

    // ----- header -----
    const hdrEnd = (() => {
        for (let i = 0; i < u8.length - 10; ++i)
            if (u8[i] === 0x0a && u8[i + 1] === 0x65 && u8[i + 10] === 0x0a) return i + 11;
    })();
    const headerTxt = new TextDecoder().decode(u8.subarray(0, hdrEnd));
    const totalPts = +headerTxt.match(/element vertex (\d+)/)[1];

    // ----- decompress full payload once -----
    const payload = decompress(u8.subarray(hdrEnd));
    const floats  = new Float32Array(payload.buffer);
    const propCount = (payload.byteLength / 4) / totalPts;   // generic!

    // ----- build octree of indices -----
    const root = { idx: [...Array(totalPts).keys()], child: [], bbox: null };
    computeBBox(root);
    splitNode(root);

    function computeBBox(node) {
        const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
        node.idx.forEach(i => {
            for (let k = 0; k < 3; k++) {
                const v = floats[i + k * totalPts];
                if (v < min[k]) min[k] = v;
                if (v > max[k]) max[k] = v;
            }
        });
        node.bbox = { min, max };
    }

    function splitNode(node) {
        if (node.idx.length <= leafPoints) return;

        // --- centre of this node's bounding box -----------------------------
        const { min, max } = node.bbox;
        const mid = min.clone().add(max).mulScalar(0.5);   // pc.Vec3

        // --- bucket indices into the 8 octants ------------------------------
        const buckets = Array.from({ length: 8 }, () => []);

        node.idx.forEach(i => {
            const bx = floats[i]                  > mid.x ? 1 : 0;
            const by = floats[i +      totalPts]  > mid.y ? 1 : 0;
            const bz = floats[i + 2 * totalPts]   > mid.z ? 1 : 0;

            const code = bx | (by << 1) | (bz << 2);   // 0-7
            buckets[code].push(i);
        });

        // --- recurse on non-empty buckets -----------------------------------
        buckets.forEach(idxArr => {
            if (!idxArr.length) return;
            const child = { idx: idxArr, child: [] };
            computeBBox(child);
            splitNode(child);
            node.child.push(child);
        });

        node.idx = null;   // free memory
    }

    // ----- leaf → compressed PLY -----
    const leaves = [];
    (function collect(n) {
        if (n.child.length) n.child.forEach(collect);
        else leaves.push(n);
    })(root);

    return leaves.map(leaf => {
        const m = leaf.idx.length;
        const buf = new ArrayBuffer(m * propCount * 4);
        const views = Array.from({ length: propCount }, (_, p) =>
            new Float32Array(buf, p * m * 4, m));
        leaf.idx.forEach((src, j) => {
            for (let p = 0; p < propCount; p++)
                views[p][j] = floats[src + p * totalPts];
        });

        const header =
`ply
format binary_little_endian 1.0
comment lz4compressed
element vertex ${m}
${['x','y','z','r','g','b','a','covL','covM','covN'].slice(0, propCount).map(n=>`property float32 ${n}`).join('\n')}
end_header
`;
        const hdrEnc = new TextEncoder().encode(header);
        const lz4    = compress(new Uint8Array(buf));
        const out    = new Uint8Array(hdrEnc.length + lz4.length);
        out.set(hdrEnc, 0); out.set(lz4, hdrEnc.length);
        return { buffer: out, bbox: leaf.bbox };
    });
}
