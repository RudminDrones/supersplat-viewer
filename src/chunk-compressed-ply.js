import { BoundingBox } from 'playcanvas';
import { GSplatData } from 'playcanvas/build/playcanvas/src/scene/gsplat/gsplat-data.js';
import { GSplatResource } from 'playcanvas/build/playcanvas/src/scene/gsplat/gsplat-resource.js';
export function chunkCompressedPly(resource, device, maxPoints = 40000) {
    const data = resource.gsplatData;
    const x = data.getProp('x');
    const y = data.getProp('y');
    const z = data.getProp('z');
    const r0 = data.getProp('rot_0');
    const r1 = data.getProp('rot_1');
    const r2 = data.getProp('rot_2');
    const r3 = data.getProp('rot_3');
    const s0 = data.getProp('scale_0');
    const s1 = data.getProp('scale_1');
    const s2 = data.getProp('scale_2');
    const c0 = data.getProp('f_dc_0');
    const c1 = data.getProp('f_dc_1');
    const c2 = data.getProp('f_dc_2');
    const op = data.getProp('opacity');
    const shProps = [];
    for (let i = 0; i < 45; i++) {
        const p = data.getProp(`f_rest_${i}`);
        if (!p) break;
        shProps.push(p);
    }

    const total = data.numSplats;
    const indices = new Array(total);
    for (let i = 0; i < total; i++) indices[i] = i;

    const tiles = [];

    const bbox = new BoundingBox();

    function computeAabb(idxs) {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const i of idxs) {
            const scale = Math.exp(Math.max(s0[i], s1[i], s2[i])) * 2.0;
            const px = x[i], py = y[i], pz = z[i];
            minX = Math.min(minX, px - scale);
            minY = Math.min(minY, py - scale);
            minZ = Math.min(minZ, pz - scale);
            maxX = Math.max(maxX, px + scale);
            maxY = Math.max(maxY, py + scale);
            maxZ = Math.max(maxZ, pz + scale);
        }
        bbox.center.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
        bbox.halfExtents.set((maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5);
        return bbox.clone();
    }

    function makeData(idxs) {
        const count = idxs.length;
        const elements = [
            {
                name: 'vertex',
                count,
                properties: [
                    { name: 'x', type: 'float', byteSize: 4, storage: new Float32Array(count) },
                    { name: 'y', type: 'float', byteSize: 4, storage: new Float32Array(count) },
                    { name: 'z', type: 'float', byteSize: 4, storage: new Float32Array(count) },
                    { name: 'rot_1', type: 'float', byteSize: 4, storage: new Float32Array(count) },
                    { name: 'rot_2', type: 'float', byteSize: 4, storage: new Float32Array(count) },
                    { name: 'rot_3', type: 'float', byteSize: 4, storage: new Float32Array(count) },
                    { name: 'rot_0', type: 'float', byteSize: 4, storage: new Float32Array(count) },
                    { name: 'scale_0', type: 'float', byteSize: 4, storage: new Float32Array(count) },
                    { name: 'scale_1', type: 'float', byteSize: 4, storage: new Float32Array(count) },
                    { name: 'scale_2', type: 'float', byteSize: 4, storage: new Float32Array(count) },
                    { name: 'f_dc_0', type: 'float', byteSize: 4, storage: new Float32Array(count) },
                    { name: 'f_dc_1', type: 'float', byteSize: 4, storage: new Float32Array(count) },
                    { name: 'f_dc_2', type: 'float', byteSize: 4, storage: new Float32Array(count) },
                    { name: 'opacity', type: 'float', byteSize: 4, storage: new Float32Array(count) }
                ]
            }
        ];
        for (let s = 0; s < shProps.length; s++) {
            elements[0].properties.push({ name: `f_rest_${s}`, type: 'float', byteSize: 4, storage: new Float32Array(count) });
        }
        const props = elements[0].properties.map(p => p.storage);
        for (let j = 0; j < count; j++) {
            const i = idxs[j];
            props[0][j] = x[i];
            props[1][j] = y[i];
            props[2][j] = z[i];
            props[3][j] = r1[i];
            props[4][j] = r2[i];
            props[5][j] = r3[i];
            props[6][j] = r0[i];
            props[7][j] = s0[i];
            props[8][j] = s1[i];
            props[9][j] = s2[i];
            props[10][j] = c0[i];
            props[11][j] = c1[i];
            props[12][j] = c2[i];
            props[13][j] = op[i];
            for (let s = 0; s < shProps.length; s++) {
                props[14 + s][j] = shProps[s][i];
            }
        }
        return new GSplatData(elements, data.comments.slice());
    }

    function split(idxs) {
        const box = computeAabb(idxs);
        if (idxs.length <= maxPoints) {
            const tileData = makeData(idxs);
            const resource = new GSplatResource(device, tileData);
            tiles.push({ resource, bbox: box });
            return;
        }
        const c = box.center;
        const children = Array.from({ length: 8 }, () => []);
        for (const i of idxs) {
            const ix = x[i] > c.x ? 1 : 0;
            const iy = y[i] > c.y ? 1 : 0;
            const iz = z[i] > c.z ? 1 : 0;
            children[ix | (iy << 1) | (iz << 2)].push(i);
        }
        for (const child of children) {
            if (child.length) split(child);
        }
    }

    split(indices);
    return tiles;
}
