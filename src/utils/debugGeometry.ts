import { Cartesian3 } from "cesium";

/** 将 ECEF 三角网索引展开为线段顶点（每三角 3 边，每边 2 点 × 3 坐标）。 */
export function buildWireframeLinesEcef(vertexEcef: Float64Array, indices: Uint32Array): Float64Array {
    const indexCount = Math.floor(indices.length / 3) * 3;
    if (indexCount < 3 || vertexEcef.length < 3) return new Float64Array(0);
    const out = new Float64Array((indexCount / 3) * 18);
    let o = 0;
    const emit = (a: number, b: number) => {
        out[o++] = vertexEcef[a * 3];
        out[o++] = vertexEcef[a * 3 + 1];
        out[o++] = vertexEcef[a * 3 + 2];
        out[o++] = vertexEcef[b * 3];
        out[o++] = vertexEcef[b * 3 + 1];
        out[o++] = vertexEcef[b * 3 + 2];
    };
    for (let t = 0; t < indexCount; t += 3) {
        const a = indices[t];
        const b = indices[t + 1];
        const d = indices[t + 2];
        emit(a, b);
        emit(b, d);
        emit(d, a);
    }
    return out;
}

/** 局部 ENU 坐标轴单轴线段（原点 → 正方向，长度米）。 */
export function buildLocalFrameAxisLocal(length: number, axis: "e" | "n" | "u"): Float64Array {
    const len = Math.max(1, length);
    if (axis === "e") return new Float64Array([0, 0, 0, len, 0, 0]);
    if (axis === "n") return new Float64Array([0, 0, 0, 0, len, 0]);
    return new Float64Array([0, 0, 0, 0, 0, len]);
}

/** 局部 ENU 坐标轴单轴线段（ECEF 世界坐标，供 Cesium Primitive 直接使用）。 */
export function buildLocalFrameAxisEcef(
    anchor: Cartesian3,
    localToEcef: (local: Cartesian3, out: Cartesian3) => Cartesian3,
    length: number,
    axis: "e" | "n" | "u",
): Float64Array {
    const len = Math.max(1, length);
    const localEnd = new Cartesian3(
        axis === "e" ? len : 0,
        axis === "n" ? len : 0,
        axis === "u" ? len : 0,
    );
    const endEcef = localToEcef(localEnd, new Cartesian3());
    return new Float64Array([
        anchor.x, anchor.y, anchor.z,
        endEcef.x, endEcef.y, endEcef.z,
    ]);
}
