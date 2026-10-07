import type { ResolvedNode } from './prefabs'

/**
 * 计算每个节点相对根的深度（沿 parentKey 链）。
 * 渲染时按深度从小到大分批，保证父节点先于子节点挂载，
 * 任意一个中途批次渲染失败时，已挂载的都是完整森林。
 */
export function nodesByDepth(nodes: Iterable<ResolvedNode>): ResolvedNode[][] {
  const list = [...nodes]
  const depthCache = new Map<string, number>()
  const byId = new Map(list.map((node) => [node.key, node]))

  const depthOf = (key: string | null): number => {
    if (!key) return -1
    const cached = depthCache.get(key)
    if (cached !== undefined) return cached
    const node = byId.get(key)
    const depth = node ? depthOf(node.parentKey) + 1 : 0
    depthCache.set(key, depth)
    return depth
  }

  const buckets = new Map<number, ResolvedNode[]>()
  list.forEach((node) => {
    const depth = depthOf(node.key)
    const bucket = buckets.get(depth)
    if (bucket) bucket.push(node)
    else buckets.set(depth, [node])
  })

  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([, bucket]) => bucket)
}

export interface RenderChunksOptions {
  /** 单批节点上限，超过则切批 */
  chunkSize: number
  /** 低于该节点总数不做分批，一次挂完 */
  threshold: number
}

/**
 * 把节点切成渲染批次。总数未超阈值时返回单批；
 * 超阈值时按深度有序切批，保证任意前缀都是可渲染的完整森林。
 */
export function planRenderChunks(
  nodes: ResolvedNode[],
  { chunkSize, threshold }: RenderChunksOptions,
): ResolvedNode[][] {
  if (nodes.length < threshold) return [nodes]
  const ordered = nodesByDepth(nodes).flat()
  const chunks: ResolvedNode[][] = []
  for (let start = 0; start < ordered.length; start += chunkSize) {
    chunks.push(ordered.slice(start, start + chunkSize))
  }
  return chunks.length ? chunks : [[]]
}
