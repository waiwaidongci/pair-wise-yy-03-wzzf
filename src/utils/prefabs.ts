import * as THREE from 'three'
import type { MaterialSpec, OverridePatch, PrefabAsset, SceneObject, Vec3 } from '../types/scene'
import { localMatrix } from './scene'

/** 解析后的节点：由场景对象或组合件模板节点（含实例内部件）展开而来 */
export interface ResolvedNode extends SceneObject {
  /** 渲染/选择用的唯一键：普通对象用对象 id；实例内部件用 instance:实例id/模板路径 */
  key: string
  /** 解析后父节点键，根节点为 null */
  parentKey: string | null
  /** 所属实例句柄 id；非实例部件为 null */
  instanceId: string | null
  /** 对应模板节点路径；非实例部件为 null */
  nodePath: string | null
  /** 该节点路径上是否存在私有覆盖 */
  overridden: boolean
}

export interface ResolveIssue {
  kind: 'cycle' | 'missingPrefab'
  prefabId: string
  fromInstanceId: string | null
  message: string
}

export interface ResolveResult {
  /** 以 key 索引的扁平节点表 */
  nodes: Map<string, ResolvedNode>
  roots: ResolvedNode[]
  /** 每个实例句柄 id 解析出的根键 */
  instanceRootKeys: Map<string, string[]>
  issues: ResolveIssue[]
}

/** 实例部件选择键前缀，配合模板路径定位 */
export const INSTANCE_KEY_PREFIX = 'instance:'

export function instanceKey(instanceId: string, nodePath: string) {
  return `${INSTANCE_KEY_PREFIX}${instanceId}/${nodePath}`
}

export function parseInstanceKey(key: string): { instanceId: string; nodePath: string } | null {
  if (!key.startsWith(INSTANCE_KEY_PREFIX)) return null
  const rest = key.slice(INSTANCE_KEY_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  return { instanceId: rest.slice(0, slash), nodePath: rest.slice(slash + 1) }
}

/** 拼接模板节点路径 */
function joinPath(parentPath: string | null, nodeId: string) {
  return parentPath ? `${parentPath}/${nodeId}` : nodeId
}

function mergePatch(a: OverridePatch, b: OverridePatch): OverridePatch {
  return { ...a, ...b, material: { ...(a.material ?? {}), ...(b.material ?? {}) } }
}

/** 字段级覆盖合并；material 按属性粒度合并，位置等向量整体覆盖 */
export function applyOverride(base: SceneObject, patch: OverridePatch): SceneObject {
  const merged: SceneObject = { ...base }
  ;(
    [
      'position',
      'rotation',
      'scale',
      'visible',
      'castShadow',
      'receiveShadow',
      'intensity',
      'distance',
      'fov',
      'activeCamera',
    ] as const
  ).forEach((field) => {
    const value = patch[field]
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[field] = value
  })
  if (patch.material) merged.material = { ...base.material, ...patch.material } as MaterialSpec
  return merged
}

function findPrefab(assets: PrefabAsset[], id: string | null | undefined) {
  if (!id) return undefined
  return assets.find((asset) => asset.id === id)
}

function overrideMap(overrides: { nodePath: string; patch: OverridePatch }[] | undefined) {
  const map = new Map<string, OverridePatch>()
  overrides?.forEach((entry) => {
    const previous = map.get(entry.nodePath)
    map.set(entry.nodePath, previous ? mergePatch(previous, entry.patch) : entry.patch)
  })
  return map
}

/**
 * 组合件引用图成环检测：以 prefab 为节点、“A 模板内含 B 的引用”为边。
 * 判断把 newChildPrefab 放进 parentPrefab（parentPrefab 为 null 表示顶层场景）是否会成环。
 * 顶层场景不参与成环，因此只有在模板内放置时才可能成环。
 */
export function wouldCreateCycle(
  prefabs: PrefabAsset[],
  parentPrefabId: string | null,
  newChildPrefabId: string,
): boolean {
  if (parentPrefabId === null) return false
  const edges = new Map<string, string[]>()
  prefabs.forEach((asset) => {
    const refs = asset.nodes.filter((node) => node.instanceOf).map((node) => node.instanceOf as string)
    edges.set(asset.id, asset.id === parentPrefabId ? [...refs, newChildPrefabId] : refs)
  })

  const stack = [newChildPrefabId]
  const seen = new Set<string>()
  while (stack.length) {
    const current = stack.pop() as string
    if (current === parentPrefabId) return true
    if (seen.has(current)) continue
    seen.add(current)
    ;(edges.get(current) ?? []).forEach((next) => stack.push(next))
  }
  return false
}

interface ExpandContext {
  sceneObjects: SceneObject[]
  assets: PrefabAsset[]
  nodes: Map<string, ResolvedNode>
  instanceRootKeys: Map<string, string[]>
  issues: ResolveIssue[]
  reportedCycles: Set<string>
  reportedMissing: Set<string>
  /** 当前展开链上的 prefab id，用于成环截断 */
  chain: string[]
  /** 外层实例在嵌套路径上的覆盖层；stripPrefix 是内层模板根之前的完整全路径前缀 */
  layers: Array<{
    instanceId: string
    /** 相对该层模板根的覆盖在全路径里要剥掉的前缀（含到模板根父节点为止） */
    stripPrefix: string
    overrides: Map<string, OverridePatch>
  }>
  /** 当前部件归属的（最外层）实例句柄 id */
  ownerInstanceId: string | null
}

/** 收集所有外层实例在某全路径上的累加覆盖 */
function inheritedOverride(
  context: ExpandContext,
  fullPath: string,
  templateRootId?: string,
): OverridePatch | undefined {
  let merged: OverridePatch | undefined
  context.layers.forEach((layer) => {
    // 剥掉该层模板根（含）之前的前缀：根节点剥后为空，回退到根 id
    let relative: string | null
    if (layer.stripPrefix === '') {
      relative = fullPath
    } else if (fullPath === layer.stripPrefix) {
      relative = templateRootId ?? fullPath.slice(layer.stripPrefix.lastIndexOf('/') + 1)
    } else if (fullPath.startsWith(`${layer.stripPrefix}/`)) {
      relative = fullPath.slice(layer.stripPrefix.length + 1)
    } else {
      relative = null
    }
    if (relative === null) return
    const patch = layer.overrides.get(relative)
    if (patch) merged = merged ? mergePatch(merged, patch) : patch
  })
  return merged
}

/** 递归展开一个模板节点及其模板子树，返回该节点产出的键 */
function expandTemplateNode(
  context: ExpandContext,
  templateNode: SceneObject,
  nodePath: string,
  parentKey: string | null,
): string {
  const ownerId = context.ownerInstanceId
  const key = ownerId ? instanceKey(ownerId, nodePath) : nodePath
  const inherited = inheritedOverride(context, nodePath, templateNode.id)
  const overridden = Boolean(inherited)
  const merged = inherited ? applyOverride(templateNode, inherited) : templateNode
  const currentAssetId = context.chain[context.chain.length - 1]

  let outputKey = key
  let childrenAssetId = currentAssetId

  if (merged.instanceOf) {
    const childAsset = findPrefab(context.assets, merged.instanceOf)
    if (context.chain.includes(merged.instanceOf)) {
      const reportKey = `${ownerId ?? 'root'}:${nodePath}`
      if (!context.reportedCycles.has(reportKey)) {
        context.reportedCycles.add(reportKey)
        context.issues.push({
          kind: 'cycle',
          prefabId: merged.instanceOf,
          fromInstanceId: ownerId,
          message: '组合件嵌套引用形成环，已截断',
        })
      }
    } else if (!childAsset) {
      if (!context.reportedMissing.has(merged.instanceOf)) {
        context.reportedMissing.add(merged.instanceOf)
        context.issues.push({
          kind: 'missingPrefab',
          prefabId: merged.instanceOf,
          fromInstanceId: ownerId,
          message: `引用的组合件「${merged.instanceOf}」不存在，已跳过`,
        })
      }
    } else {
      const nestedInstanceId = ownerId ? `${ownerId}>${nodePath}` : `tpl:${nodePath}`
      const rootKeys = expandInstance(
        context,
        childAsset,
        merged,
        overrideMap(merged.overrides),
        parentKey,
        nodePath,
        nestedInstanceId,
        true,
      )
      if (rootKeys[0]) outputKey = rootKeys[0]
      // 句柄的模板子节点仍属于当前资产模板，挂到嵌套实例根下
      childrenAssetId = currentAssetId
    }
  } else {
    const resolved: ResolvedNode = {
      ...merged,
      parentId: null,
      instanceOf: null,
      overrides: undefined,
      key,
      parentKey,
      instanceId: ownerId,
      nodePath: ownerId ? nodePath : null,
      overridden,
    }
    context.nodes.set(key, resolved)
  }

  const asset = findPrefab(context.assets, childrenAssetId)
  asset?.nodes
    .filter((node) => node.parentId === templateNode.id)
    .forEach((child) => expandTemplateNode(context, child, joinPath(nodePath, child.id), outputKey))

  return outputKey
}

/** 展开实例句柄：单根模板直接套到根；多根模板合成 group 容器 */
function expandInstance(
  context: ExpandContext,
  asset: PrefabAsset,
  handle: SceneObject,
  ownOverrides: Map<string, OverridePatch>,
  parentKey: string | null,
  pathPrefix: string | null,
  instanceId: string,
  /** true=模板内嵌套句柄：句柄摆放即模板值，自带覆盖相对内层模板根（前缀为空） */
  templateNested = false,
): string[] {
  const roots = asset.nodes.filter((node) => node.parentId === null)

  // 该实例层覆盖键相对“它引用模板的根”。展开内层各节点时，全路径去掉 stripPrefix
  // （含内层模板根这一段）后正好是覆盖键：
  // - 顶层单根实例：stripPrefix = 根路径，如 booth-base，部件 booth-base/booth-top → booth-top
  // - 多根合成容器 / 模板内嵌套句柄：stripPrefix = 句柄节点路径（内层根挂在其下）
  const multiRoot = roots.length !== 1
  const stripPrefix = multiRoot
    ? joinPath(pathPrefix, handle.id)
    : joinPath(pathPrefix, roots[0].id)

  const nested: ExpandContext = {
    ...context,
    chain: [...context.chain, asset.id],
    layers: [
      ...context.layers,
      { instanceId, stripPrefix, overrides: ownOverrides },
    ],
    ownerInstanceId: instanceId,
  }

  if (multiRoot) {
    const groupPath = joinPath(pathPrefix, handle.id)
    const groupKey = instanceKey(instanceId, groupPath)
    const group: ResolvedNode = {
      id: handle.id,
      name: handle.name,
      type: 'group',
      parentId: null,
      visible: handle.visible,
      position: handle.position,
      rotation: handle.rotation,
      scale: handle.scale,
      castShadow: false,
      receiveShadow: false,
      material: { color: '#ffffff', roughness: 1, metalness: 0, opacity: 1, wireframe: false },
      key: groupKey,
      parentKey,
      instanceId,
      nodePath: groupPath,
      overridden: true,
    }
    context.nodes.set(groupKey, group)
    roots.forEach((templateRoot) =>
      expandTemplateNode(nested, templateRoot, joinPath(pathPrefix, templateRoot.id), groupKey),
    )
    context.instanceRootKeys.set(handle.id, [groupKey])
    return [groupKey]
  }

  const templateRoot = roots[0]
  const rootPath = joinPath(pathPrefix, templateRoot.id)

  // 句柄摆放（位置/旋转/缩放/可见）：
  // - 顶层实例：作为根覆盖，名字用实例名
  // - 模板内嵌套句柄：摆放即模板值，铺到模板根上
  const handlePatch: OverridePatch = {
    position: handle.position,
    rotation: handle.rotation,
    scale: handle.scale,
    visible: handle.visible,
  }
  const rootOverride = templateNested
    ? (ownOverrides.get(templateRoot.id) ?? {})
    : mergePatch(handlePatch, ownOverrides.get(templateRoot.id) ?? {})

  const rootKey = instanceKey(instanceId, rootPath)
  const inherited = inheritedOverride(nested, rootPath, templateRoot.id)
  const baseForRoot = templateNested ? applyOverride(templateRoot, handlePatch) : templateRoot
  const rootMerged = applyOverride(
    inherited ? applyOverride(baseForRoot, inherited) : baseForRoot,
    rootOverride,
  )

  if (rootMerged.instanceOf) {
    // 模板根自身就是嵌套引用：交给模板节点流程（自带成环保护）
    const created = expandTemplateNode(nested, rootMerged, rootPath, parentKey)
    context.instanceRootKeys.set(handle.id, [created])
    return [created]
  }

  const resolved: ResolvedNode = {
    ...rootMerged,
    parentId: null,
    instanceOf: null,
    overrides: undefined,
    name: handle.name,
    key: rootKey,
    parentKey,
    instanceId,
    nodePath: rootPath,
    overridden: true,
  }
  context.nodes.set(rootKey, resolved)

  asset.nodes
    .filter((node) => node.parentId === templateRoot.id)
    .forEach((child) => expandTemplateNode(nested, child, joinPath(rootPath, child.id), rootKey))

  context.instanceRootKeys.set(handle.id, [rootKey])
  return [rootKey]
}

function visitSceneObject(
  context: ExpandContext,
  object: SceneObject,
  parentKey: string | null,
  rootSink: ResolvedNode[],
) {
  if (object.instanceOf) {
    const asset = findPrefab(context.assets, object.instanceOf)
    if (!asset) {
      if (!context.reportedMissing.has(object.instanceOf)) {
        context.reportedMissing.add(object.instanceOf)
        context.issues.push({
          kind: 'missingPrefab',
          prefabId: object.instanceOf,
          fromInstanceId: object.id,
          message: `实例「${object.name}」引用的组合件不存在，已跳过`,
        })
      }
      return
    }
    if (context.chain.includes(object.instanceOf)) {
      if (!context.reportedCycles.has(object.id)) {
        context.reportedCycles.add(object.id)
        context.issues.push({
          kind: 'cycle',
          prefabId: object.instanceOf,
          fromInstanceId: object.id,
          message: `实例「${object.name}」的组合件嵌套形成环，已截断`,
        })
      }
      return
    }

    const createdKeys = expandInstance(
      context,
      asset,
      object,
      overrideMap(object.overrides),
      parentKey,
      null,
      object.id,
    )
    if (!parentKey) {
      createdKeys.forEach((key) => {
        const node = context.nodes.get(key)
        if (node) rootSink.push(node)
      })
    }

    // 挂在实例句柄下的场景普通对象：附到唯一的实例根上
    const attachKey = createdKeys.length === 1 ? createdKeys[0] : parentKey
    context.sceneObjects
      .filter((item) => item.parentId === object.id)
      .forEach((child) => visitSceneObject(context, child, attachKey, rootSink))
    return
  }

  const key = object.id
  const resolved: ResolvedNode = {
    ...object,
    instanceOf: undefined,
    overrides: undefined,
    key,
    parentKey,
    instanceId: null,
    nodePath: null,
    overridden: false,
  }
  context.nodes.set(key, resolved)
  if (!parentKey) rootSink.push(resolved)

  context.sceneObjects
    .filter((item) => item.parentId === object.id)
    .forEach((child) => visitSceneObject(context, child, key, rootSink))
}

/**
 * 解析场景：普通对象原样输出，组合件引用递归展开为部件节点。
 * 成环引用会被截断并以 issues 返回，绝不死循环。
 */
export function resolveScene(objects: SceneObject[], prefabs: PrefabAsset[]): ResolveResult {
  const context: ExpandContext = {
    sceneObjects: objects,
    assets: prefabs,
    nodes: new Map(),
    instanceRootKeys: new Map(),
    issues: [],
    reportedCycles: new Set(),
    reportedMissing: new Set(),
    chain: [],
    layers: [],
    ownerInstanceId: null,
  }
  const roots: ResolvedNode[] = []
  objects
    .filter((object) => object.parentId === null)
    .forEach((object) => visitSceneObject(context, object, null, roots))
  return { nodes: context.nodes, roots, instanceRootKeys: context.instanceRootKeys, issues: context.issues }
}

/** 解析一个组合件资产（编辑源模式下查看模板，模板内嵌套引用照常展开） */
export function resolvePrefab(asset: PrefabAsset, prefabs: PrefabAsset[]): ResolveResult {
  return resolveScene(asset.nodes, prefabs)
}

/** 计算解析节点的世界矩阵（沿 parentKey 链） */
export function resolvedWorldMatrix(
  key: string,
  nodes: Map<string, ResolvedNode>,
  cache = new Map<string, THREE.Matrix4>(),
): THREE.Matrix4 {
  const cached = cache.get(key)
  if (cached) return cached
  const node = nodes.get(key)
  if (!node) return new THREE.Matrix4()
  const parent = node.parentKey ? resolvedWorldMatrix(node.parentKey, nodes, cache) : new THREE.Matrix4()
  const result = parent.clone().multiply(localMatrix(node))
  cache.set(key, result)
  return result
}

/** 把世界矩阵分解回 position/rotation/scale（烘焙组合件时用） */
export function decomposeMatrix(matrix: THREE.Matrix4): { position: Vec3; rotation: Vec3; scale: Vec3 } {
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  matrix.decompose(position, quaternion, scale)
  const euler = new THREE.Euler().setFromQuaternion(quaternion)
  return {
    position: [position.x, position.y, position.z],
    rotation: [euler.x, euler.y, euler.z],
    scale: [scale.x, scale.y, scale.z],
  }
}

/** 对象类型守卫：组合件句柄 */
export function isInstanceHandle(object: SceneObject | undefined | null): object is SceneObject {
  return Boolean(object && object.instanceOf)
}
